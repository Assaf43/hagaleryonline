import {
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  MAX_COUPON_CODE_LENGTH,
  type CartView,
  type CustomerAddressView,
  type ShippingQuote,
  type StoreCartView,
  type StoreCustomerLookup,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { CartError, CartService, type CartResult } from '../cart/cart.service.js';
import { badField } from '../customers/account-errors.js';
import { normalizePhone } from '../customers/contact-normalize.js';
import { AccountErrorFilter } from '../customers/customer-auth.controller.js';
import { parseQuoteRequest, quoteItems } from '../shipping/shipping.controller.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { StoreCartService } from './store-cart.service.js';
import { parseStoreCodeInput, parseStoreVerifyInput, StoreCustomerService } from './store-customer.service.js';

/** Most units one request may ask for; the line limit clamps it further (as on the website). */
const MAX_REQUEST_QUANTITY = 999;
const invalidInput = () => new CartError(HttpStatus.BAD_REQUEST, 'invalid_input');
const notFound = () => new CartError(HttpStatus.NOT_FOUND, 'not_found');

function parseId(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw invalidInput();
  return value;
}

function parseIdParam(value: string): number {
  if (!/^\d+$/.test(value)) throw invalidInput();
  return parseId(Number(value));
}

function parseQuantity(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_REQUEST_QUANTITY)
    throw invalidInput();
  return value;
}

/**
 * The seller's store cart (spec §4.2, ADM-18): `/api/admin/store-cart`. Every call works on the signed-in seller's
 * own open cart and delegates to the website's `CartService`; the answer is the cart view plus the attached customer.
 * No cookie is read or set. The customer endpoints (`customer/*`, spec §4.1 step 2) confirm the customer by a one-time
 * code without a customer session; their account errors answer like the account API (with `Retry-After` on 429).
 */
@Controller('admin/store-cart')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('orders.store')
@UseFilters(AccountErrorFilter)
export class StoreCartController {
  constructor(
    private readonly carts: CartService,
    private readonly storeCarts: StoreCartService,
    private readonly storeCustomers: StoreCustomerService,
    private readonly audit: AuditService,
    private readonly shipping: ShippingService,
  ) {}

  /** The open cart; 204 when there is none. */
  @Header('Cache-Control', 'no-store')
  @Get()
  async get(@Admin() admin: AdminContext, @Res({ passthrough: true }) res: Response): Promise<StoreCartView | void> {
    const cart = await this.storeCarts.open(admin.user.id);
    if (!cart) {
      res.status(HttpStatus.NO_CONTENT);
      return;
    }
    return this.respond(cart.id, await this.carts.read(this.storeCarts.ownerOf(admin.user.id, cart.id)));
  }

  /** A new sale: replaces the open cart with an empty one. */
  @Header('Cache-Control', 'no-store')
  @Post()
  async start(@Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<StoreCartView> {
    const cart = await this.storeCarts.start(admin.user.id);
    await this.audit.record({
      actorId: admin.user.id,
      action: 'store_cart.start',
      entityType: 'cart',
      entityId: cart.id,
      ip: client.ip,
    });
    return this.respond(cart.id, await this.carts.read(this.storeCarts.ownerOf(admin.user.id, cart.id)));
  }

  @Header('Cache-Control', 'no-store')
  @Post('items')
  async add(@Body() body: unknown, @Admin() admin: AdminContext): Promise<StoreCartView> {
    const { variantId, quantity } = (body ?? {}) as Record<string, unknown>;
    const id = parseId(variantId);
    const qty = parseQuantity(quantity);
    return this.change(admin, (owner) => this.carts.add(owner, id, qty));
  }

  @Header('Cache-Control', 'no-store')
  @Patch('items/:variantId')
  async update(
    @Param('variantId') variantId: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
  ): Promise<StoreCartView> {
    const { quantity } = (body ?? {}) as Record<string, unknown>;
    const id = parseIdParam(variantId);
    const qty = parseQuantity(quantity);
    return this.change(admin, (owner) => this.carts.update(owner, id, qty));
  }

  @Header('Cache-Control', 'no-store')
  @Delete('items/:variantId')
  async remove(@Param('variantId') variantId: string, @Admin() admin: AdminContext): Promise<StoreCartView> {
    const id = parseIdParam(variantId);
    return this.change(admin, (owner) => this.carts.remove(owner, id));
  }

  @Header('Cache-Control', 'no-store')
  @Post('coupon')
  async applyCoupon(@Body() body: unknown, @Admin() admin: AdminContext): Promise<StoreCartView> {
    const { code } = (body ?? {}) as Record<string, unknown>;
    if (typeof code !== 'string' || code.trim().length === 0 || code.trim().length > MAX_COUPON_CODE_LENGTH)
      throw invalidInput();
    return this.change(admin, (owner) => this.carts.applyCoupon(owner, code));
  }

  @Header('Cache-Control', 'no-store')
  @Delete('coupon')
  @HttpCode(HttpStatus.OK)
  async removeCoupon(@Admin() admin: AdminContext): Promise<StoreCartView> {
    return this.change(admin, (owner) => this.carts.removeCoupon(owner));
  }

  /**
   * Both shipping methods for the open cart's lines and the address (spec §4.1 step 3): the storefront quote's body
   * and answer, on the same code path. No open cart, or no lines → 409 `empty_cart`.
   */
  @Header('Cache-Control', 'no-store')
  @Post('shipping-quote')
  @HttpCode(HttpStatus.OK)
  async quote(@Body() body: unknown, @Admin() admin: AdminContext): Promise<ShippingQuote> {
    const request = parseQuoteRequest(body);
    const cart = await this.storeCarts.open(admin.user.id);
    // No open cart has no lines: the storefront's empty-cart answer.
    const items = cart ? await this.carts.shippableItems(this.storeCarts.ownerOf(admin.user.id, cart.id)) : [];
    return quoteItems(this.shipping, items, request);
  }

  /** The confirmed customer's saved addresses, default first; 409 `customer_not_confirmed` without a live one. */
  @Header('Cache-Control', 'no-store')
  @Get('customer/addresses')
  addresses(@Admin() admin: AdminContext): Promise<CustomerAddressView[]> {
    return this.storeCustomers.addresses(admin.user.id);
  }

  /** Whether the phone has an account (opens the seller's cart when there is none). */
  @Header('Cache-Control', 'no-store')
  @Post('customer/lookup')
  @HttpCode(HttpStatus.OK)
  lookup(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<StoreCustomerLookup> {
    const phone = normalizePhone(((body ?? {}) as Record<string, unknown>).phone);
    if (!phone) throw badField('phone');
    return this.storeCustomers.lookup({ sellerId: admin.user.id, ip: client.ip }, phone);
  }

  /** Sends the confirmation code (per-seller limit `store_otp`). */
  @Header('Cache-Control', 'no-store')
  @Post('customer/code')
  @HttpCode(HttpStatus.NO_CONTENT)
  async sendCode(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta) {
    const input = parseStoreCodeInput(body);
    await this.storeCustomers.requestCode({ sellerId: admin.user.id, ip: client.ip }, input);
  }

  /** Checks the code and attaches the customer (a new phone gets its quick account); never a customer session. */
  @Header('Cache-Control', 'no-store')
  @Post('customer/verify')
  @HttpCode(HttpStatus.OK)
  async verify(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<StoreCartView> {
    const input = parseStoreVerifyInput(body);
    const cartId = await this.storeCustomers.verify({ sellerId: admin.user.id, ip: client.ip }, input);
    return this.respond(cartId, await this.carts.read(this.storeCarts.ownerOf(admin.user.id, cartId)));
  }

  /** Drops the confirmed customer from the open cart; 404 when there is none. */
  @Header('Cache-Control', 'no-store')
  @Delete('customer')
  @HttpCode(HttpStatus.OK)
  async clearCustomer(@Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<StoreCartView> {
    const cartId = await this.storeCustomers.clear({ sellerId: admin.user.id, ip: client.ip });
    return this.respond(cartId, await this.carts.read(this.storeCarts.ownerOf(admin.user.id, cartId)));
  }

  /**
   * Runs a line or coupon change on the seller's open cart, under the seller's store-cart lock (`changeOpen`); 404
   * when there is none, or when it got its order or was replaced by a new sale meanwhile.
   */
  private async change(
    admin: AdminContext,
    run: (owner: ReturnType<StoreCartService['ownerOf']>) => Promise<CartResult>,
  ): Promise<StoreCartView> {
    const sellerId = admin.user.id;
    const done = await this.storeCarts.changeOpen(sellerId, async (cartId) => ({
      cartId,
      result: await run(this.storeCarts.ownerOf(sellerId, cartId)),
    }));
    if (!done) throw notFound();
    return this.respond(done.cartId, done.result);
  }

  private respond(cartId: string, result: CartResult): Promise<StoreCartView> {
    const view: CartView = result.view;
    return this.storeCarts.withCustomer(cartId, view);
  }
}
