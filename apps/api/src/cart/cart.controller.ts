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
import type { CookieOptions, Request, Response } from 'express';
import type { CartView } from '@hg/models';
import { SameOriginGuard } from '../auth/guards.js';
import { CART_COOKIE, CART_TTL_MS } from './cart-token.js';
import { CartError, CartService, type CartResult } from './cart.service.js';

/** Most units one request may ask for; the line limit clamps it further. */
const MAX_REQUEST_QUANTITY = 999;

/** Public cart API (spec §3.1). Every write goes through SameOriginGuard (storefront origin only). */
@Controller('cart')
@UseGuards(SameOriginGuard)
export class CartController {
  constructor(private readonly cart: CartService) {}

  @Get()
  async get(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    return respond(req, res, await this.cart.read(tokenOf(req)));
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  async add(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    const { variantId, quantity } = (body ?? {}) as Record<string, unknown>;
    const result = await this.cart.add(tokenOf(req), parseId(variantId), parseQuantity(quantity));
    return respond(req, res, result);
  }

  @Patch('items/:variantId')
  async update(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartView> {
    const { quantity } = (body ?? {}) as Record<string, unknown>;
    const result = await this.cart.update(tokenOf(req), parseId(Number(variantId)), parseQuantity(quantity));
    return respond(req, res, result);
  }

  @Delete('items/:variantId')
  async remove(
    @Param('variantId') variantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartView> {
    return respond(req, res, await this.cart.remove(tokenOf(req), parseId(Number(variantId))));
  }
}

function tokenOf(req: Request): string | undefined {
  const value: unknown = req.cookies?.[CART_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
  };
}

/** Renews the cookie of a live cart; drops a cookie that no longer names one. */
function respond(req: Request, res: Response, { view, token }: CartResult): CartView {
  if (token) res.cookie(CART_COOKIE, token, { ...cookieOptions(), maxAge: CART_TTL_MS });
  else if (tokenOf(req)) res.clearCookie(CART_COOKIE, cookieOptions());
  return view;
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
