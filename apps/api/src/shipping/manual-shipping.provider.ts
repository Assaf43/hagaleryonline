import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { ShippingQuote } from '@hg/models';
import type { ProviderQuoteRequest, ShipmentOrder, ShippingProvider } from './shipping-provider.js';
import { quoteShipping, shippingUnits } from './shipping-rules.js';
import { ShippingPriceList } from './shipping.service.js';

/**
 * `manual` adapter (SHP-06, SHP-07): quotes from the admin price list; delivery is coordinated by staff,
 * so creating a shipment records nothing outside the site.
 */
@Injectable()
export class ManualShippingProvider implements ShippingProvider {
  readonly code = 'manual';

  constructor(private readonly priceList: ShippingPriceList) {}

  async quote(req: ProviderQuoteRequest): Promise<ShippingQuote> {
    const [{ rates, settings }, zone] = await Promise.all([
      this.priceList.load(),
      this.priceList.zoneOf(req.localityId),
    ]);
    const methods = quoteShipping(shippingUnits(req.items, rates), settings, {
      floor: req.floor,
      hasElevator: req.hasElevator,
      zoneSurcharge: zone?.surcharge ?? 0,
      zoneName: zone?.name,
    });
    return { methods };
  }

  createShipment(order: ShipmentOrder): Promise<{ shipmentId: string }> {
    void order;
    return Promise.resolve({ shipmentId: `manual-${randomUUID()}` });
  }
}
