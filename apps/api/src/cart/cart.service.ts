import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { CartErrorCode, CartLine, CartNotice, CartView, CouponProblem, FulfillmentMode } from '@hg/models';
import { FULFILLMENT } from '../catalog/catalog.repository.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { memberSavings, priceCart, regularDiscountLines, unpricedLine } from '../promotions/cart-pricing.js';
import {
  couponError,
  couponProblemMessageHe,
  eligibleSubtotal,
  type DiscountLine,
} from '../promotions/discount-engine.js';
import { normalizeCouponCode, PromotionsService } from '../promotions/promotions.service.js';
import type { ShipmentItem } from '../shipping/shipping-provider.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { availableStock } from './available-stock.js';
import { computeCartLines, findShown, pricingLine, shipmentItems } from './cart-lines.js';
import { clampQuantity, deliveryEstimate, lineLimit } from './cart-rules.js';
import { CART_TTL_MS, hashToken, newToken } from './cart-token.js';
import type { CatalogSnapshot } from '../catalog/catalog-snapshot.js';
import { OrderStatus, type Prisma } from '../generated/prisma/client.js';
import { lockAccountCart, lockCart } from '../orders/locks.js';
import { isConfirmationLive, lapseStoreConfirmation } from '../store-orders/store-confirmation.js';

const CLEANUP_EVERY_MS = 24 * 60 * 60_000;

/**
 * A cart view plus what the `hg_cart` cookie should carry: a guest cart's token, null (no cart: drop the cookie), or
 * undefined (a signed-in customer: the account's cart is found by the session, the cookie is left alone).
 */
export interface CartResult {
  view: CartView;
  token: string | null | undefined;
}

/** Whose cart: the signed-in customer's (by `customerId`, the cookie is ignored) or the guest cart of the cookie. */
export interface CartOwner {
  token: string | undefined;
  customerId: string | null;
  /**
   * A seller's store cart (Phase 6, spec §4.2): found by its id and seller, never by cookie or account; `token` and
   * `customerId` are ignored. It is priced for the customer the seller attached (`storeCustomerId`).
   */
  store?: { sellerId: number; cartId: string };
}

const cookieOf = (owner: CartOwner): string | undefined => (owner.customerId || owner.store ? undefined : owner.token);
const noCart = (owner: CartOwner): null | undefined => (owner.customerId || owner.store ? undefined : null);

/** The account's live carts, newest first (normally one: sign-in merges them). */
function liveAccountCarts(db: Prisma.TransactionClient | PrismaService, customerId: string) {
  return db.cart.findMany({
    where: { customerId, sellerId: null, updatedAt: { gte: staleBefore(new Date()) } },
    orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
    select: { id: true },
  });
}

export class CartError extends HttpException {
  constructor(status: HttpStatus, code: CartErrorCode) {
    super({ statusCode: status, code }, status);
  }
}

/** 400 of POST /api/cart/coupon: `{ statusCode, code: 'invalid_coupon', field: 'coupon', messageHe }`. */
export class CouponRefused extends HttpException {
  constructor(messageHe: string) {
    const status = HttpStatus.BAD_REQUEST;
    super({ statusCode: status, code: 'invalid_coupon' satisfies CartErrorCode, field: 'coupon', messageHe }, status);
  }
}

/** Coupon problems that will not go away by changing the cart: the code is removed from the cart (shown once). */
const DROP_COUPON: ReadonlySet<CouponProblem> = new Set(['unknown', 'not_started', 'expired', 'exhausted']);

const notFound = () => new CartError(HttpStatus.NOT_FOUND, 'not_found');
const unavailable = () => new CartError(HttpStatus.CONFLICT, 'unavailable');

function emptyView(): CartView {
  return {
    lines: [],
    itemCount: 0,
    subtotal: 0,
    deliveryEstimate: null,
    notices: [],
    shippingFrom: null,
    discount: null,
    couponCode: null,
    pricing: 'regular',
    memberSavings: null,
  };
}

/**
 * Server-side cart (spec §3.1, decision 68, CRT-02, CRT-04). Shown data and visibility come from the catalog
 * snapshot; price and stock are read fresh from the database on every request, so totals are always the server's.
 * A signed-in customer has one cart, found by the account (spec §6.4): every browser of the account sees and changes
 * the same cart, and the view offers the welcome benefit to an account without a paid order (decision 79). A guest's
 * cart is found by the `hg_cart` cookie.
 */
@Injectable()
export class CartService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartService.name);
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly shipping: ShippingService,
    private readonly promotions: PromotionsService,
  ) {}

  onModuleInit(): void {
    const cleanup = () =>
      this.deleteStaleCarts().catch((error: unknown) => this.logger.error('Cart cleanup failed', error));
    void cleanup();
    this.cleanupTimer = setInterval(() => void cleanup(), CLEANUP_EVERY_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Deletes carts unused for 30 days (their lines go with them). */
  async deleteStaleCarts(now = new Date()): Promise<number> {
    const { count } = await this.prisma.cart.deleteMany({ where: { updatedAt: { lt: staleBefore(now) } } });
    return count;
  }

  /** Never creates a cart. */
  async read(owner: CartOwner): Promise<CartResult> {
    const cart = await this.resolve(owner);
    if (!cart) return { view: emptyView(), token: noCart(owner) };
    return { view: await this.buildView(cart.id, [], owner), token: cookieOf(owner) };
  }

  /**
   * Adds to the variant's line (creating the cart on the first add), clamped to the line limit. The first add of a
   * signed-in customer creates the account's cart under the account's cart lock, so two first adds make one cart.
   */
  async add(owner: CartOwner, variantId: number, quantity: number): Promise<CartResult> {
    const existing = await this.resolve(owner);
    // A store cart is only ever started by its seller (StoreCartService.start), never created by an add.
    if (owner.store && !existing) throw notFound();
    const orderable = await this.orderable(variantId, existing?.id);
    if (!orderable) throw notFound();
    const { price, limit, fulfillment } = orderable;
    if (limit < 1) throw unavailable();
    const { customerId } = owner;

    // One transaction: create the cart if needed, then an atomic insert-or-increment (INSERT … ON CONFLICT),
    // so adds that arrive together never lose quantity; the result is clamped to the line limit.
    const { cartId, liveToken, wanted } = await this.prisma.$transaction(async (tx) => {
      let cartId = existing?.id;
      let liveToken = owner.token;
      if (!cartId && customerId) {
        await lockAccountCart(tx, customerId);
        cartId = (await liveAccountCarts(tx, customerId))[0]?.id;
      }
      if (!cartId || (!customerId && !liveToken && !owner.store)) {
        // An account cart's token is never handed out: the account's cart is found by the session.
        liveToken = newToken();
        cartId = (await tx.cart.create({ data: { tokenHash: hashToken(liveToken), customerId }, select: { id: true } }))
          .id;
      }
      const key = { cartId_variantId: { cartId, variantId } };
      // Adding again means the customer saw the current price: it becomes the line's reference price.
      const item = await tx.cartItem.upsert({
        where: key,
        create: { cartId, variantId, quantity, unitPriceAtAdd: price },
        update: { quantity: { increment: quantity }, unitPriceAtAdd: price },
        select: { quantity: true },
      });
      const next = clampQuantity(item.quantity, limit);
      if (next !== item.quantity) await tx.cartItem.update({ where: key, data: { quantity: next } });
      return { cartId, liveToken, wanted: item.quantity };
    });
    const notices = wanted > limit ? [clampedNotice(variantId, fulfillment, limit)] : [];
    return {
      view: await this.buildView(cartId, notices, owner),
      token: customerId || owner.store ? undefined : (liveToken ?? null),
    };
  }

  /** Sets the quantity of an existing line, clamped to the line limit. */
  async update(owner: CartOwner, variantId: number, quantity: number): Promise<CartResult> {
    const cart = await this.resolve(owner);
    const item =
      cart && (await this.prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } }));
    if (!cart || !item) throw notFound();
    // The line exists, so a variant that is no longer shown is unavailable rather than unknown.
    const orderable = await this.orderable(variantId, cart.id);
    if (!orderable || orderable.limit < 1) throw unavailable();
    const { limit, fulfillment } = orderable;
    const next = clampQuantity(quantity, limit);
    await this.prisma.cartItem.update({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      data: { quantity: next },
    });
    const notices = next < quantity ? [clampedNotice(variantId, fulfillment, limit)] : [];
    return { view: await this.buildView(cart.id, notices, owner), token: cookieOf(owner) };
  }

  /** Removes a line; removing a line that is not there is not an error. */
  async remove(owner: CartOwner, variantId: number): Promise<CartResult> {
    const cart = await this.resolve(owner);
    if (!cart) return { view: emptyView(), token: noCart(owner) };
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
    return { view: await this.buildView(cart.id, [], owner), token: cookieOf(owner) };
  }

  /**
   * Enters a coupon (spec §6): checked against the cart as it is now — unknown, expired, used up, below its minimum
   * or for none of the cart's products → 400 with the Hebrew reason and nothing stored. A valid coupon is stored
   * upper-case even when an automatic promotion is better (the view then says so). Never creates a cart.
   */
  async applyCoupon(owner: CartOwner, rawCode: string): Promise<CartResult> {
    const code = normalizeCouponCode(rawCode);
    const cart = await this.resolve(owner);
    // Checked at regular prices: the most lenient of the two pricings (decision 92) — a coupon that fits only at
    // regular prices is still a valid entry, and the view then says whether member pricing beat it.
    const lines: DiscountLine[] = cart
      ? regularDiscountLines(
          (await computeCartLines(this.prisma, cart.id, await this.catalog.snapshot()))
            .filter((l) => l.available)
            .map((l) => pricingLine(l, l.quantity)),
        )
      : [];
    const buyer = cart ? await this.buyer(cart.id, owner) : { customerId: null, isMember: false };
    // Uses as checkout counts them: this cart's own pending orders do not hold the coupon against it; a members-only
    // coupon also counts the account's own uses (once per account, decision 94).
    const found = await this.promotions.coupon(
      this.prisma,
      code,
      { cartId: cart?.id },
      buyer.isMember ? buyer.customerId : null,
    );
    const message = couponError(found, found ? eligibleSubtotal(found, lines) : 0, new Date(), {
      isMember: buyer.isMember,
    });
    if (message) throw new CouponRefused(message);
    // A valid coupon has eligible lines, so there is a cart.
    await this.prisma.cart.update({ where: { id: cart!.id }, data: { couponCode: code } });
    return { view: await this.buildView(cart!.id, [], owner), token: cookieOf(owner) };
  }

  /** Removes the cart's coupon; without a cart, the empty view. */
  async removeCoupon(owner: CartOwner): Promise<CartResult> {
    const cart = await this.resolve(owner);
    if (!cart) return { view: emptyView(), token: noCart(owner) };
    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return { view: await this.buildView(cart.id, [], owner), token: cookieOf(owner) };
  }

  /**
   * Cart merge on sign-in (spec §6.4), called by every sign-in path before the session starts. One cart per account:
   * the account's newest live cart absorbs the guest cart of the cookie and every other live cart of the account —
   * quantities summed and clamped to the line limits (CRT-02), the first coupon found carried over when it has none.
   * Without an account cart, the guest cart simply becomes the account's. Nothing to merge: nothing changes.
   * An absorbed cart that still has live pending orders is emptied and detached instead of deleted, so those orders
   * keep their cart (line clearing on payment, the superseded check). A cart of another account in the cookie is never
   * a guest cart (`resolve` does not return it), so it is never merged.
   * Locks: the account's cart lock, then every cart involved by ascending id (locks.ts); the lines, limits and coupons
   * are read under them. A cart deleted meanwhile (a double-submitted sign-in) is skipped.
   */
  async attachToCustomer(guestToken: string | undefined, customerId: string): Promise<void> {
    const guest = await this.resolve({ token: guestToken, customerId: null });
    const snapshot = await this.catalog.snapshot();
    await this.prisma.$transaction(
      async (tx) => {
        await lockAccountCart(tx, customerId);
        const [target, ...others] = await liveAccountCarts(tx, customerId);
        if (!target) {
          // Only while still a guest cart (never another account's).
          if (guest) await tx.cart.updateMany({ where: { id: guest.id, customerId: null }, data: { customerId } });
          return;
        }
        // The guest cart was read before the lock: a concurrent sign-in of this browser may have linked it to the
        // account meanwhile (it is then the target itself, never merged into itself).
        const sources = [...(guest ? [guest.id] : []), ...others.map((c) => c.id)].filter((id) => id !== target.id);
        if (sources.length === 0) return;
        const locked = new Set<string>();
        for (const id of [target.id, ...sources].sort()) if (await lockCart(tx, id)) locked.add(id);
        if (!locked.has(target.id)) return;

        for (const sourceId of sources) {
          if (!locked.has(sourceId)) continue;
          const source = await tx.cart.findUnique({
            where: { id: sourceId },
            select: { customerId: true, couponCode: true, items: true },
          });
          // Re-checked under the lock: the guest cart must still be a guest cart, the others still this account's.
          const expectedOwner = sourceId === guest?.id ? null : customerId;
          if (!source || source.customerId !== expectedOwner) continue;
          for (const item of source.items) {
            const key = { cartId_variantId: { cartId: target.id, variantId: item.variantId } };
            const existing = await tx.cartItem.findUnique({ where: key, select: { quantity: true } });
            const wanted = (existing?.quantity ?? 0) + item.quantity;
            const limit = (await this.orderable(item.variantId, target.id, tx, snapshot))?.limit ?? 0;
            // A line that cannot be bought now keeps its quantity (the cart shows it unavailable, as for any line).
            const quantity = limit >= 1 ? clampQuantity(wanted, limit) : wanted;
            await tx.cartItem.upsert({
              where: key,
              create: {
                cartId: target.id,
                variantId: item.variantId,
                quantity,
                unitPriceAtAdd: item.unitPriceAtAdd,
                addedAt: item.addedAt,
              },
              update: { quantity },
            });
          }
          if (source.couponCode)
            await tx.cart.updateMany({
              where: { id: target.id, couponCode: null },
              data: { couponCode: source.couponCode },
            });
          const livePending = await tx.order.count({
            where: { cartId: sourceId, status: OrderStatus.PENDING_PAYMENT, reservedUntil: { gt: new Date() } },
          });
          if (livePending > 0) {
            await tx.cartItem.deleteMany({ where: { cartId: sourceId } });
            await tx.cart.update({ where: { id: sourceId }, data: { customerId: null, couponCode: null } });
          } else {
            await tx.cart.delete({ where: { id: sourceId } });
          }
        }
        await tx.cart.update({ where: { id: target.id }, data: { updatedAt: new Date() } });
      },
      { timeout: 15_000 },
    );
  }

  /**
   * The available lines to ship (quantity clamped to the line limit), without the cart view's side effects:
   * notices stay for the cart page. Empty when there is no cart.
   */
  async shippableItems(owner: CartOwner): Promise<ShipmentItem[]> {
    const cart = await this.resolve(owner);
    if (!cart) return [];
    return shipmentItems(await computeCartLines(this.prisma, cart.id, await this.catalog.snapshot()));
  }

  /**
   * The owner's cart, marked as used. Signed in: the account's newest live cart, never the cookie's. A guest: the
   * cookie's cart, unless it belongs to an account; an expired cart is deleted and reads as none.
   */
  async resolve(owner: CartOwner): Promise<{ id: string } | null> {
    const now = new Date();
    if (owner.store) {
      const { sellerId, cartId } = owner.store;
      await lapseStoreConfirmation(this.prisma, cartId, now);
      const cart = await this.prisma.cart.findFirst({
        where: { id: cartId, sellerId, updatedAt: { gte: staleBefore(now) } },
        select: { id: true },
      });
      if (!cart) return null;
      // A concurrent new sale of the same seller may have just replaced this cart: then it reads as none.
      const touched = await this.prisma.cart.updateMany({ where: { id: cart.id }, data: { updatedAt: now } });
      return touched.count === 1 ? cart : null;
    }
    if (owner.customerId) {
      const cart = (await liveAccountCarts(this.prisma, owner.customerId))[0];
      if (!cart) return null;
      await this.prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: now } });
      return cart;
    }
    if (!owner.token) return null;
    const cart = await this.prisma.cart.findUnique({
      where: { tokenHash: hashToken(owner.token) },
      select: { id: true, updatedAt: true, customerId: true, sellerId: true },
    });
    if (!cart || cart.customerId !== null || cart.sellerId !== null) return null;
    if (cart.updatedAt < staleBefore(now)) {
      await this.prisma.cart.deleteMany({ where: { id: cart.id } });
      return null;
    }
    await this.prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: now } });
    return { id: cart.id };
  }

  /** A shown variant's current price, fulfillment and line limit (for this cart); null when it is not shown. */
  private async orderable(
    variantId: number,
    cartId?: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    snapshot?: CatalogSnapshot,
  ) {
    const shown = findShown(snapshot ?? (await this.catalog.snapshot()), variantId);
    const variant = await db.variant.findUnique({
      where: { id: variantId },
      select: { price: true, fulfillment: true, active: true },
    });
    if (!shown || !variant?.active) return null;
    const fulfillment = FULFILLMENT[variant.fulfillment];
    const stock = (await availableStock(db, [variantId], cartId)).get(variantId) ?? 0;
    return { price: variant.price, fulfillment, limit: lineLimit(fulfillment, stock) };
  }

  /**
   * Who the cart is priced for (decision 90, spec §9): a signed-in account's cart, or a store cart with a live
   * confirmed customer, is a member's; a guest cart (or a store cart without a confirmed customer) never is.
   * `customerId` is the account the welcome benefit and the once-per-account coupons are counted for.
   */
  private async buyer(cartId: string, owner: CartOwner): Promise<{ customerId: string | null; isMember: boolean }> {
    if (!owner.store) return { customerId: owner.customerId, isMember: owner.customerId !== null };
    const cart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cartId },
      select: { storeCustomerId: true, storeConfirmedAt: true, updatedAt: true },
    });
    // A store cart is priced for the customer the seller attached (the welcome benefit, as before) and is a member's
    // cart while that customer's confirmation is live (spec §9).
    return {
      customerId: cart.storeCustomerId,
      isMember: cart.storeCustomerId !== null && isConfirmationLive(cart),
    };
  }

  /**
   * Recomputes every line (spec §3.1): price changes, limits (clamped and saved) and visibility. Line totals, subtotal
   * and discount come from `priceCart` only (decision 92): member pricing for a member's cart when it is not dearer,
   * and for a guest the hint of what a member would save on the same cart.
   */
  private async buildView(cartId: string, requestNotices: CartNotice[], owner: CartOwner): Promise<CartView> {
    const computed = await computeCartLines(this.prisma, cartId, await this.catalog.snapshot());

    const notices: CartNotice[] = [...requestNotices];
    for (const line of computed) {
      const { variantId, available, shown, limit, fulfillment } = line;
      if (!available) {
        // Shown but nothing left to sell → sold out; no longer shown → unavailable.
        notices.push({
          variantId,
          kind: 'unavailable',
          messageHe: shown ? `${line.modelName} אזל מהמלאי` : `${line.modelName} לא זמין יותר`,
        });
        continue;
      }
      const fix: { quantity?: number; unitPriceAtAdd?: number } = {};
      if (line.storedQuantity > limit) {
        fix.quantity = limit;
        notices.push(clampedNotice(variantId, fulfillment, limit));
      }
      if (line.unitPrice !== line.unitPriceAtAdd) {
        // Shown once: from now on the new price is the line's reference price.
        fix.unitPriceAtAdd = line.unitPrice;
        notices.push({ variantId, kind: 'price_changed', messageHe: `המחיר של ${line.modelName} עודכן` });
      }
      if (Object.keys(fix).length > 0)
        await this.prisma.cartItem.update({ where: { cartId_variantId: { cartId, variantId } }, data: fix });
    }

    // The one discount (spec §6), on the available lines at the quantities shown. A coupon that does not apply now
    // gets a notice; one that never will again (unknown, expired, used up) is also removed, so its notice shows once.
    const { couponCode } = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cartId },
      select: { couponCode: true },
    });
    const { customerId, isMember } = await this.buyer(cartId, owner);
    const customer = await this.promotions.welcomeCustomer(this.prisma, customerId);
    const available = computed.filter((l) => l.available);
    const pricingLines = available.map((l) => pricingLine(l, l.quantity));
    const priced = await priceCart({
      lines: pricingLines,
      isMember,
      evaluate: (lines) => this.promotions.evaluate(this.prisma, lines, couponCode, { cartId, customer, isMember }),
    });
    // The guest hint: the same cart priced as a member's (members-only promotions included, no account to count).
    const savings = isMember
      ? null
      : memberSavings(
          priced,
          await priceCart({
            lines: pricingLines,
            isMember: true,
            evaluate: (lines) =>
              this.promotions.evaluate(this.prisma, lines, couponCode, { cartId, customer: null, isMember: true }),
          }),
        );
    const discount = priced.discount;
    let code = couponCode;
    if (code && discount.couponProblem) {
      notices.push({
        variantId: null,
        kind: 'coupon',
        messageHe: couponProblemMessageHe(discount.couponProblem, discount.coupon),
      });
      if (DROP_COUPON.has(discount.couponProblem)) {
        // Only if unchanged: a coupon entered meanwhile stays.
        await this.prisma.cart.updateMany({ where: { id: cartId, couponCode: code }, data: { couponCode: null } });
        code = null;
      }
    }

    const pricedLines = new Map(available.map((l, i) => [l.variantId, priced.lines[i]]));
    const lines: CartLine[] = computed.map((line) => {
      const { variantId, available, shown, limit, fulfillment } = line;
      // An unavailable line keeps its saved quantity (shown at its regular price, but left out of totals and checkout).
      const quantity = available ? line.quantity : line.storedQuantity;
      const price = pricedLines.get(variantId) ?? unpricedLine(line.unitPrice, quantity);
      return {
        variantId,
        productSlug: line.productSlug,
        modelName: line.modelName,
        nameHe: line.nameHe,
        optionLabels: line.optionLabels,
        image: line.image,
        unitPrice: price.unitPrice,
        compareAtPrice: line.compareAtPrice,
        memberPrice: line.memberPrice,
        atMemberPrice: price.atMemberPrice,
        quantity,
        lineTotal: price.lineTotal,
        maxQuantity: limit,
        fulfillment,
        leadTimeDays: line.leadTimeDays,
        available,
        // Shown but nothing left to sell → sold out; no longer shown → hidden.
        unavailableReason: available ? null : shown ? 'sold_out' : 'hidden',
      };
    });

    return {
      lines,
      itemCount: available.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: priced.subtotal,
      deliveryEstimate: deliveryEstimate(lines),
      notices,
      shippingFrom: await this.shipping.shippingFrom(shipmentItems(computed)),
      discount: discount.applied,
      couponCode: code,
      pricing: priced.pricing,
      memberSavings: savings,
    };
  }
}

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - CART_TTL_MS);
}

function clampedNotice(variantId: number, fulfillment: FulfillmentMode, limit: number): CartNotice {
  return {
    variantId,
    kind: 'quantity_clamped',
    messageHe: fulfillment === 'in_stock' ? `נשארו רק ${limit} במלאי` : `אפשר להזמין עד ${limit} יחידות`,
  };
}
