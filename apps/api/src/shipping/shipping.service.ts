import { HttpException, HttpStatus, Inject, Injectable } from '@nestjs/common';
import type { ShippingErrorCode, ShippingQuote, ShippingQuoteRequest } from '@hg/models';
import { PrismaService } from '../prisma/prisma.service.js';
import { SHIPPING_PROVIDER, type ShipmentItem, type ShippingProvider } from './shipping-provider.js';
import {
  isShippingConfigured,
  shippingFrom,
  shippingUnits,
  type ShippingPriceSettings,
  type ShippingRateRow,
} from './shipping-rules.js';

export class ShippingError extends HttpException {
  constructor(status: HttpStatus, code: ShippingErrorCode) {
    super({ statusCode: status, code }, status);
  }
}

/** The price list has no default rate row yet, so shipping cannot be priced (checkout must not treat it as free). */
export class ShippingNotConfiguredError extends Error {
  constructor() {
    super('Shipping is not configured');
    this.name = 'ShippingNotConfiguredError';
  }
}

/** Used until staff save the settings in the admin. */
export const DEFAULT_SETTINGS: ShippingPriceSettings = {
  additionalItemPercent: 50,
  floorSurcharge: 0,
  floorSurchargeFrom: 2,
};

/** The price list managed in the admin (spec §4.1, §4.4): rates, settings and remote zones. */
@Injectable()
export class ShippingPriceList {
  constructor(private readonly prisma: PrismaService) {}

  async load(): Promise<{ rates: ShippingRateRow[]; settings: ShippingPriceSettings }> {
    const [rates, settings] = await Promise.all([
      this.prisma.shippingRate.findMany({ select: { categoryId: true, deliveryPrice: true, assemblyPrice: true } }),
      this.prisma.shippingSettings.findUnique({
        where: { id: 1 },
        select: { additionalItemPercent: true, floorSurcharge: true, floorSurchargeFrom: true },
      }),
    ]);
    return { rates, settings: settings ?? DEFAULT_SETTINGS };
  }

  /** The remote zone of a locality, if any (a locality is in at most one zone). */
  async zoneOf(localityId: number): Promise<{ name: string; surcharge: number } | null> {
    const link = await this.prisma.zoneLocality.findUnique({
      where: { localityId },
      select: { zone: { select: { name: true, surcharge: true } } },
    });
    return link?.zone ?? null;
  }
}

/** Shipping for the cart (spec §4.3): quotes through the active provider, and the cart's "from" price. */
@Injectable()
export class ShippingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly priceList: ShippingPriceList,
    @Inject(SHIPPING_PROVIDER) private readonly provider: ShippingProvider,
  ) {}

  /** Both methods for the available cart lines; 400 for an unknown locality, 409 when nothing can be shipped, throws ShippingNotConfiguredError without a default rate. */
  async quote(items: ShipmentItem[], req: ShippingQuoteRequest): Promise<ShippingQuote> {
    const locality = await this.prisma.locality.findUnique({ where: { id: req.localityId }, select: { id: true } });
    if (!locality) throw new ShippingError(HttpStatus.BAD_REQUEST, 'unknown_locality');
    if (items.every((i) => i.quantity < 1)) throw new ShippingError(HttpStatus.CONFLICT, 'empty_cart');
    const { rates } = await this.priceList.load();
    if (!isShippingConfigured(rates)) throw new ShippingNotConfiguredError();
    return this.provider.quote({ ...req, items });
  }

  /** Lowest delivery price of the price list (CRT-05): curbside without zone or floor surcharges; null when empty or not configured. */
  async shippingFrom(items: ShipmentItem[]): Promise<number | null> {
    if (items.every((i) => i.quantity < 1)) return null;
    const { rates, settings } = await this.priceList.load();
    if (!isShippingConfigured(rates)) return null;
    return shippingFrom(shippingUnits(items, rates), settings);
  }
}
