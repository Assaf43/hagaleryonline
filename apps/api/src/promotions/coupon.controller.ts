import { Body, Controller, Delete, HttpCode, HttpStatus, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { MAX_COUPON_CODE_LENGTH, type CartView } from '@hg/models';
import { AuthConfig } from '../auth/auth.config.js';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { customerIdOf, sendCart } from '../cart/cart.controller.js';
import { cartTokenOf as tokenOf } from '../cart/cart-token.js';
import { CartError, CartService } from '../cart/cart.service.js';
import { OptionalCustomer, OptionalCustomerGuard } from '../customers/customer-session.guard.js';
import type { ResolvedCustomer } from '../customers/customer-session.service.js';
import { Throttled, WriteThrottleGuard } from '../orders/write-throttle.js';

/**
 * The cart's coupon (spec §6, CRT-03): `POST /api/cart/coupon {code}` checks the code against the cart and stores it
 * (400 `invalid_coupon` with `messageHe` otherwise); `DELETE /api/cart/coupon` removes it. Both answer the cart view.
 */
@Controller('cart/coupon')
@UseGuards(StorefrontOriginGuard, OptionalCustomerGuard)
export class CouponController {
  constructor(
    private readonly cart: CartService,
    private readonly config: AuthConfig,
  ) {}

  /** Throttled per IP: its distinct messages would otherwise let a script enumerate codes. */
  @Post()
  @HttpCode(HttpStatus.OK)
  @UseGuards(WriteThrottleGuard)
  @Throttled('coupon')
  async apply(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CartView> {
    const { code } = (body ?? {}) as Record<string, unknown>;
    if (typeof code !== 'string' || code.trim().length === 0 || code.trim().length > MAX_COUPON_CODE_LENGTH)
      throw new CartError(HttpStatus.BAD_REQUEST, 'invalid_input');
    return sendCart(this.config, req, res, await this.cart.applyCoupon(tokenOf(req), code, customerIdOf(customer)));
  }

  @Delete()
  async remove(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CartView> {
    return sendCart(this.config, req, res, await this.cart.removeCoupon(tokenOf(req), customerIdOf(customer)));
  }
}
