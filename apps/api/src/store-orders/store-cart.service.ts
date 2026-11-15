import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CartView, StoreCartView, StoreCustomer } from '@hg/models';
import { CART_TTL_MS, hashToken } from '../cart/cart-token.js';
import type { CartOwner } from '../cart/cart.service.js';
import { CustomerOrigin } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hasPaidOrder } from '../promotions/promotions.service.js';
import { lapseStoreConfirmation } from './store-confirmation.js';

/**
 * The seller's store cart (spec §4.2): the website cart's pricing, promotion and stock code (`CartService`), owned by a
 * seller instead of a cookie or an account. A store cart never has a `customerId`; the customer the seller attaches is
 * `storeCustomerId`, which prices the welcome benefit but is never merged into an account cart.
 */
@Injectable()
export class StoreCartService {
  constructor(private readonly prisma: PrismaService) {}

  /** The seller's open cart: the newest one with no order at all, used within the last 30 days. */
  async open(sellerId: number): Promise<{ id: string } | null> {
    const cart = await this.prisma.cart.findFirst({
      where: { sellerId, orders: { none: {} }, updatedAt: { gte: new Date(Date.now() - CART_TTL_MS) } },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      select: { id: true },
    });
    if (cart) await this.lapseConfirmation(cart.id);
    return cart;
  }

  /** Starts a new sale: drops the seller's open cart (no order, so only a basket is lost) and creates an empty one. */
  async start(sellerId: number): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      await tx.cart.deleteMany({ where: { sellerId, orders: { none: {} } } });
      // The token is never handed out: a store cart is found by its seller, not by a cookie.
      return tx.cart.create({
        data: { tokenHash: hashToken(randomBytes(32).toString('base64url')), sellerId },
        select: { id: true },
      });
    });
  }

  /** The attached customer lapses after two hours (see `lapseStoreConfirmation`). */
  lapseConfirmation(cartId: string): Promise<void> {
    return lapseStoreConfirmation(this.prisma, cartId);
  }

  ownerOf(sellerId: number, cartId: string): CartOwner {
    return { token: undefined, customerId: null, store: { sellerId, cartId } };
  }

  /** The view the admin shows: the website cart view plus the attached customer. */
  async withCustomer(cartId: string, view: CartView): Promise<StoreCartView> {
    const cart = await this.prisma.cart.findUnique({
      where: { id: cartId },
      select: { storeCustomer: true },
    });
    const c = cart?.storeCustomer;
    if (!c) return { ...view, customer: null };
    const customer: StoreCustomer = {
      id: c.id,
      fullName: c.fullName,
      phone: c.phone,
      email: c.email,
      emailVerified: c.emailVerifiedAt !== null,
      isNew: c.createdVia === CustomerOrigin.STORE && !(await hasPaidOrder(this.prisma, c.id)),
    };
    return { ...view, customer };
  }
}
