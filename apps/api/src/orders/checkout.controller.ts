import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { CheckoutResponse } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { cartTokenOf } from '../cart/cart-token.js';
import { CheckoutService } from './checkout.service.js';
import { Throttled, WriteThrottleGuard } from './write-throttle.js';

/** POST /api/checkout (spec §5.2): the cart of the cookie becomes an order; storefront origin only. */
@Controller('checkout')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @Throttled('checkout')
  create(@Body() body: unknown, @Req() req: Request): Promise<CheckoutResponse> {
    return this.checkout.checkout(cartTokenOf(req), body);
  }
}
