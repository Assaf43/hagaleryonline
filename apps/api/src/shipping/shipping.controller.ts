import { Body, Controller, HttpCode, HttpStatus, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { ShippingQuote, ShippingQuoteRequest } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { cartTokenOf } from '../cart/cart-token.js';
import { CartService } from '../cart/cart.service.js';
import { MAX_FLOOR } from './shipping-rules.js';
import { ShippingError, ShippingNotConfiguredError, ShippingService } from './shipping.service.js';

/** Public shipping API (spec §4.3). POSTs go through StorefrontOriginGuard (storefront origin only). */
@Controller('shipping')
@UseGuards(StorefrontOriginGuard)
export class ShippingController {
  constructor(
    private readonly cart: CartService,
    private readonly shipping: ShippingService,
  ) {}

  /** Both methods with a line-by-line breakdown for the cart of the cookie (SHP-01–03). */
  @Post('quote')
  @HttpCode(HttpStatus.OK)
  async quote(@Body() body: unknown, @Req() req: Request): Promise<ShippingQuote> {
    const request = parseQuoteRequest(body);
    const items = await this.cart.shippableItems(cartTokenOf(req));
    try {
      return await this.shipping.quote(items, request);
    } catch (e) {
      if (e instanceof ShippingNotConfiguredError)
        throw new ShippingError(HttpStatus.SERVICE_UNAVAILABLE, 'shipping_unavailable');
      throw e;
    }
  }
}

function parseQuoteRequest(body: unknown): ShippingQuoteRequest {
  const { localityId, floor, hasElevator } = (body ?? {}) as Record<string, unknown>;
  if (typeof localityId !== 'number' || !Number.isSafeInteger(localityId) || localityId < 1) throw invalidInput();
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0 || floor > MAX_FLOOR) throw invalidInput();
  if (typeof hasElevator !== 'boolean') throw invalidInput();
  return { localityId, floor, hasElevator };
}

const invalidInput = () => new ShippingError(HttpStatus.BAD_REQUEST, 'invalid_input');
