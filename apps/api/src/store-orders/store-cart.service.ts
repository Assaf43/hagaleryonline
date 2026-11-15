import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { CartView, StoreCartView, StoreCustomer } from '@hg/models';
import { CART_TTL_MS, hashToken } from '../cart/cart-token.js';
import type { CartOwner } from '../cart/cart.service.js';
import { CustomerOrigin, type Prisma } from '../generated/prisma/client.js';
import { lockStoreCart } from '../orders/locks.js';
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
    const cart = await findOpen(this.prisma, sellerId);
    if (cart) await this.lapseConfirmation(cart.id);
    return cart;
  }

  /** Starts a new sale: drops the seller's open cart (no order, so only a basket is lost) and creates an empty one. */
  async start(sellerId: number): Promise<{ id: string }> {
    return this.prisma.$transaction(async (tx) => {
      await lockStoreCart(tx, sellerId);
      await tx.cart.deleteMany({ where: { sellerId, orders: { none: {} } } });
      return createStoreCart(tx, sellerId);
    });
  }

  /** The open cart, or a new one when there is none; `created` tells the caller to audit the new sale. */
  async openOrStart(sellerId: number): Promise<{ id: string; created: boolean }> {
    const cart = await this.prisma.$transaction((tx) => this.openOrStartInTx(tx, sellerId));
    if (!cart.created) await this.lapseConfirmation(cart.id);
    return cart;
  }

  /**
   * The same inside the caller's transaction, under the seller's store-cart lock (taken here, first): concurrent
   * calls of one seller find or create the same single open cart. The caller lapses an old confirmation itself.
   */
  async openOrStartInTx(tx: Prisma.TransactionClient, sellerId: number): Promise<{ id: string; created: boolean }> {
    const open = await this.openIfAnyInTx(tx, sellerId);
    if (open) return { id: open.id, created: false };
    return { ...(await createStoreCart(tx, sellerId)), created: true };
  }

  /** The open cart under the seller's store-cart lock (taken here, first), without creating one. */
  async openIfAnyInTx(tx: Prisma.TransactionClient, sellerId: number): Promise<{ id: string } | null> {
    await lockStoreCart(tx, sellerId);
    return findOpen(tx, sellerId);
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

function findOpen(db: Prisma.TransactionClient | PrismaService, sellerId: number): Promise<{ id: string } | null> {
  return db.cart.findFirst({
    where: { sellerId, orders: { none: {} }, updatedAt: { gte: new Date(Date.now() - CART_TTL_MS) } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: { id: true },
  });
}

/** The token is never handed out: a store cart is found by its seller, not by a cookie. */
function createStoreCart(tx: Prisma.TransactionClient, sellerId: number): Promise<{ id: string }> {
  return tx.cart.create({
    data: { tokenHash: hashToken(randomBytes(32).toString('base64url')), sellerId },
    select: { id: true },
  });
}
