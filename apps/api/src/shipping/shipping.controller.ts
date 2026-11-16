import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { ShippingQuote, ShippingQuoteRequest } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { ownerOf } from '../cart/cart.controller.js';
import { CartService } from '../cart/cart.service.js';
import type { ShipmentItem } from './shipping-provider.js';
import { OptionalCustomer, OptionalCustomerGuard } from '../customers/customer-session.guard.js';
import type { ResolvedCustomer } from '../customers/customer-session.service.js';
import { MAX_FLOOR } from './shipping-rules.js';
import { ShippingError, ShippingNotConfiguredError, ShippingService } from './shipping.service.js';

/** Public shipping API (spec §4.3). POSTs go through StorefrontOriginGuard (storefront origin only). */
@Controller('shipping')
@UseGuards(StorefrontOriginGuard, OptionalCustomerGuard)
export class ShippingController {
  constructor(
    private readonly cart: CartService,
    private readonly shipping: ShippingService,
  ) {}

  /** Both methods with a line-by-line breakdown for the cart (the account's, else the cookie's; SHP-01–03). */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  async quote(
    @Body() body: unknown,
    @Req() req: Request,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<ShippingQuote> {
    const request = parseQuoteRequest(body);
    return quoteItems(this.shipping, await this.cart.shippableItems(ownerOf(req, customer)), request);
  }
}

/**
 * The quote of a cart's lines (the website's cookie or account cart, or a seller's store cart): 409 `empty_cart`
 * without lines, 503 `shipping_unavailable` when the price list is not configured.
 */
export async function quoteItems(
  shipping: ShippingService,
  items: ShipmentItem[],
  request: ShippingQuoteRequest,
): Promise<ShippingQuote> {
  try {
    return await shipping.quote(items, request);
  } catch (e) {
    if (e instanceof ShippingNotConfiguredError)
      throw new ShippingError(HttpStatus.SERVICE_UNAVAILABLE, 'shipping_unavailable');
    throw e;
  }
}

/** Validates a quote request (400 `invalid_input`); shared with the store cart's quote (Phase 6). */
export function parseQuoteRequest(body: unknown): ShippingQuoteRequest {
  const { localityId, floor, hasElevator } = (body ?? {}) as Record<string, unknown>;
  if (typeof localityId !== 'number' || !Number.isSafeInteger(localityId) || localityId < 1) throw invalidInput();
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0 || floor > MAX_FLOOR) throw invalidInput();
  if (typeof hasElevator !== 'boolean') throw invalidInput();
  return { localityId, floor, hasElevator };
}

const invalidInput = () => new ShippingError(HttpStatus.BAD_REQUEST, 'invalid_input');
