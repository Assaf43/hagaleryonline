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
import { AuthConfig } from '../auth/auth.config.js';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { CART_COOKIE, CART_TTL_MS } from './cart-token.js';
import { CartError, CartService, type CartResult } from './cart.service.js';

/** Most units one request may ask for; the line limit clamps it further. */
const MAX_REQUEST_QUANTITY = 999;

/** Public cart API (spec §3.1). Every write goes through StorefrontOriginGuard (storefront origin only). */
@Controller('cart')
@UseGuards(StorefrontOriginGuard)
export class CartController {
  constructor(
    private readonly cart: CartService,
    private readonly config: AuthConfig,
  ) {}

  @Get()
  async get(@Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    return this.respond(req, res, await this.cart.read(tokenOf(req)));
  }

  @Post('items')
  @HttpCode(HttpStatus.OK)
  async add(@Body() body: unknown, @Req() req: Request, @Res({ passthrough: true }) res: Response): Promise<CartView> {
    const { variantId, quantity } = (body ?? {}) as Record<string, unknown>;
    const result = await this.cart.add(tokenOf(req), parseId(variantId), parseQuantity(quantity));
    return this.respond(req, res, result);
  }

  @Patch('items/:variantId')
  async update(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartView> {
    const { quantity } = (body ?? {}) as Record<string, unknown>;
    const result = await this.cart.update(tokenOf(req), parseIdParam(variantId), parseQuantity(quantity));
    return this.respond(req, res, result);
  }

  @Delete('items/:variantId')
  async remove(
    @Param('variantId') variantId: string,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<CartView> {
    return this.respond(req, res, await this.cart.remove(tokenOf(req), parseIdParam(variantId)));
  }

  /** Renews the cookie of a live cart; drops a cookie that no longer names one. */
  private respond(req: Request, res: Response, { view, token }: CartResult): CartView {
    const options: CookieOptions = { httpOnly: true, sameSite: 'lax', secure: this.config.cookieSecure, path: '/' };
    if (token) res.cookie(CART_COOKIE, token, { ...options, maxAge: CART_TTL_MS });
    else if (tokenOf(req)) res.clearCookie(CART_COOKIE, options);
    return view;
  }
}

function tokenOf(req: Request): string | undefined {
  const value: unknown = req.cookies?.[CART_COOKIE];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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
