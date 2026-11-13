import { Body, Controller, Get, Header, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CheckoutPrefill, CheckoutResponse } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { customerIdOf } from '../cart/cart.controller.js';
import { cartTokenOf } from '../cart/cart-token.js';
import { OptionalCustomer, OptionalCustomerGuard } from '../customers/customer-session.guard.js';
import type { ResolvedCustomer } from '../customers/customer-session.service.js';
import { CheckoutService } from './checkout.service.js';
import { Throttled, WriteThrottleGuard } from './write-throttle.js';

/**
 * POST /api/checkout (spec §5.2): the cart of the cookie becomes an order; storefront origin only. With a customer
 * session the order belongs to the account (spec §6.4); GET /api/checkout/prefill fills the form for it.
 */
@Controller('checkout')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard, OptionalCustomerGuard)
export class CheckoutController {
  constructor(private readonly checkout: CheckoutService) {}

  @Post()
  @Throttled('checkout')
  create(
    @Body() body: unknown,
    @Req() req: Request,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CheckoutResponse> {
    return this.checkout.checkout(cartTokenOf(req), body, customerIdOf(customer));
  }

  /** The account's contact and saved addresses; 204 for a guest. Personal: never cached. */
  @Get('prefill')
  @Header('Cache-Control', 'no-store')
  async prefill(
    @OptionalCustomer() customer: ResolvedCustomer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CheckoutPrefill | undefined> {
    if (!customer) {
      res.status(HttpStatus.NO_CONTENT);
      return undefined;
    }
    return this.checkout.prefill(customer.customer.id);
  }
}
