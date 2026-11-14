import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import type { CartView } from '@hg/models';
import { AuthConfig } from '../auth/auth.config.js';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { OptionalCustomer, OptionalCustomerGuard, customerCookieOptions } from '../customers/customer-session.guard.js';
import type { ResolvedCustomer } from '../customers/customer-session.service.js';
import { CART_COOKIE, CART_TTL_MS, cartTokenOf as tokenOf } from './cart-token.js';
import { CartError, CartService, type CartOwner, type CartResult } from './cart.service.js';

/** Most units one request may ask for; the line limit clamps it further. */
const MAX_REQUEST_QUANTITY = 999;

/**
 * Public cart API (spec §3.1). Every write goes through StorefrontOriginGuard (storefront origin only). The signed-in
 * customer, if any, owns a newly created cart and may see the welcome benefit (spec §6.4).
 */
@Controller('cart')
@UseGuards(StorefrontOriginGuard, OptionalCustomerGuard)
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly config: AuthConfig,
  ) {}

  @Get()
  async get(
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CartView> {
    return this.respond(req, res, await this.cart.read(ownerOf(req, customer)));
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  async add(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CartView> {
    const { variantId, quantity } = (body ?? {}) as Record<string, unknown>;
    const result = await this.cart.add(ownerOf(req, customer), parseId(variantId), parseQuantity(quantity));
    return this.respond(req, res, result);
  }

  @Patch('items/:variantId')
  async update(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CartView> {
    const { quantity } = (body ?? {}) as Record<string, unknown>;
    const result = await this.cart.update(ownerOf(req, customer), parseIdParam(variantId), parseQuantity(quantity));
    return this.respond(req, res, result);
  }

  @Delete('items/:variantId')
  async remove(
    @Param('variantId') variantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
    @OptionalCustomer() customer: ResolvedCustomer | null,
  ): Promise<CartView> {
    return this.respond(req, res, await this.cart.remove(ownerOf(req, customer), parseIdParam(variantId)));
  }

  private respond(req: Request, res: Response, result: CartResult): CartView {
    return sendCart(this.config, req, res, result);
  }
}

/**
 * Renews the cookie of a live guest cart; drops a cookie that no longer names one; leaves it alone for a signed-in
 * customer (token undefined). Returns the view to send.
 */
export function sendCart(config: AuthConfig, req: Request, res: Response, { view, token }: CartResult): CartView {
  if (token !== undefined) writeCartCookie(config, res, token, tokenOf(req) !== undefined);
  return view;
}

/**
 * Sets the `hg_cart` cookie to `token`, or drops it (when the request had one) for null. Same flags as `hg_customer`:
 * httpOnly, SameSite=Lax, path /, Secure when COOKIE_SECURE=true or in production.
 */
export function writeCartCookie(
  config: Pick<AuthConfig, 'cookieSecure' | 'nodeEnv'>,
  res: Response,
  token: string | null,
  hadCookie: boolean,
): void {
  const options = customerCookieOptions(config.cookieSecure, config.nodeEnv);
  if (token) res.cookie(CART_COOKIE, token, { ...options, maxAge: CART_TTL_MS });
  else if (hadCookie) res.clearCookie(CART_COOKIE, options);
}

/** The signed-in customer's id, or null for a guest. */
export function customerIdOf(customer: ResolvedCustomer | null): string | null {
  return customer?.customer.id ?? null;
}

/** Whose cart a request works on: the signed-in account's, else the cookie's guest cart. */
export function ownerOf(req: Request, customer: ResolvedCustomer | null): CartOwner {
  return { token: tokenOf(req), customerId: customerIdOf(customer) };
}

function parseIdParam(value: string): number {
  if (!/^\d+$/.test(value)) throw invalidInput();
  return parseId(Number(value));
}

function parseId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}

function parseQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_REQUEST_QUANTITY)
    throw invalidInput();
  return value;
}

const invalidInput = () => new CartError(HttpStatus.BAD_REQUEST, 'invalid_input');
