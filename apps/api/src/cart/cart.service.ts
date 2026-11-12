import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { CartErrorCode, CartLine, CartNotice, CartView, CouponProblem, FulfillmentMode } from '@hg/models';
import { FULFILLMENT } from '../catalog/catalog.repository.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { couponError, couponProblemMessageHe, eligibleSubtotal } from '../promotions/discount-engine.js';
import { discountLines, normalizeCouponCode, PromotionsService } from '../promotions/promotions.service.js';
import type { ShipmentItem } from '../shipping/shipping-provider.js';
import { ShippingService } from '../shipping/shipping.service.js';
import { availableStock } from './available-stock.js';
import { computeCartLines, findShown, shipmentItems } from './cart-lines.js';
import { clampQuantity, deliveryEstimate, lineLimit } from './cart-rules.js';
import { CART_TTL_MS, hashToken, newToken } from './cart-token.js';

const CLEANUP_EVERY_MS = 24 * 60 * 60_000;

/** A cart view plus the token the cookie should carry (null: there is no cart). */
export interface CartResult {
  view: CartView;
  token: string | null;
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
  };
}

/**
 * Server-side cart (spec §3.1, decision 68, CRT-02, CRT-04). Shown data and visibility come from the catalog
 * snapshot; price and stock are read fresh from the database on every request, so totals are always the server's.
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
  async read(token: string | undefined): Promise<CartResult> {
    const cart = await this.resolve(token);
    if (!cart) return { view: emptyView(), token: null };
    return { view: await this.buildView(cart.id, []), token: token! };
  }

  /** Adds to the variant's line (creating the cart on the first add), clamped to the line limit. */
  async add(token: string | undefined, variantId: number, quantity: number): Promise<CartResult> {
    const existing = token ? await this.resolve(token) : null;
    const orderable = await this.orderable(variantId, existing?.id);
    if (!orderable) throw notFound();
    const { price, limit, fulfillment } = orderable;
    if (limit < 1) throw unavailable();

    // One transaction: create the cart if needed, then an atomic insert-or-increment (INSERT … ON CONFLICT),
    // so adds that arrive together never lose quantity; the result is clamped to the line limit.
    const { cartId, liveToken, wanted } = await this.prisma.$transaction(async (tx) => {
      let cartId = existing?.id;
      let liveToken = token;
      if (!cartId || !liveToken) {
        liveToken = newToken();
        cartId = (await tx.cart.create({ data: { tokenHash: hashToken(liveToken) }, select: { id: true } })).id;
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
    return { view: await this.buildView(cartId, notices), token: liveToken };
  }

  /** Sets the quantity of an existing line, clamped to the line limit. */
  async update(token: string | undefined, variantId: number, quantity: number): Promise<CartResult> {
    const cart = await this.resolve(token);
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
    return { view: await this.buildView(cart.id, notices), token: token! };
  }

  /** Removes a line; removing a line that is not there is not an error. */
  async remove(token: string | undefined, variantId: number): Promise<CartResult> {
    const cart = await this.resolve(token);
    if (!cart) return { view: emptyView(), token: null };
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
    return { view: await this.buildView(cart.id, []), token: token! };
  }

  /**
   * Enters a coupon (spec §6): checked against the cart as it is now — unknown, expired, used up, below its minimum
   * or for none of the cart's products → 400 with the Hebrew reason and nothing stored. A valid coupon is stored
   * upper-case even when an automatic promotion is better (the view then says so). Never creates a cart.
   */
  async applyCoupon(token: string | undefined, rawCode: string): Promise<CartResult> {
    const code = normalizeCouponCode(rawCode);
    const cart = await this.resolve(token);
    const lines = cart
      ? discountLines(await computeCartLines(this.prisma, cart.id, await this.catalog.snapshot()), (l) => l.quantity)
      : [];
    // Uses as checkout counts them: this cart's own pending orders do not hold the coupon against it.
    const found = await this.promotions.coupon(this.prisma, code, { cartId: cart?.id });
    const message = couponError(found, found ? eligibleSubtotal(found, lines) : 0, new Date());
    if (message) throw new CouponRefused(message);
    // A valid coupon has eligible lines, so there is a cart.
    await this.prisma.cart.update({ where: { id: cart!.id }, data: { couponCode: code } });
    return { view: await this.buildView(cart!.id, []), token: token! };
  }

  /** Removes the cart's coupon; without a cart, the empty view. */
  async removeCoupon(token: string | undefined): Promise<CartResult> {
    const cart = await this.resolve(token);
    if (!cart) return { view: emptyView(), token: null };
    await this.prisma.cart.update({ where: { id: cart.id }, data: { couponCode: null } });
    return { view: await this.buildView(cart.id, []), token: token! };
  }

  /**
   * The available lines to ship (quantity clamped to the line limit), without the cart view's side effects:
   * notices stay for the cart page. Empty when there is no cart.
   */
  async shippableItems(token: string | undefined): Promise<ShipmentItem[]> {
    const cart = await this.resolve(token);
    if (!cart) return [];
    return shipmentItems(await computeCartLines(this.prisma, cart.id, await this.catalog.snapshot()));
  }

  /** The cart of a cookie token, marked as used; an expired cart is deleted and reads as none. */
  async resolve(token: string | undefined): Promise<{ id: string } | null> {
    if (!token) return null;
    const now = new Date();
    const cart = await this.prisma.cart.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, updatedAt: true },
    });
    if (!cart) return null;
    if (cart.updatedAt < staleBefore(now)) {
      await this.prisma.cart.deleteMany({ where: { id: cart.id } });
      return null;
    }
    await this.prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: now } });
    return { id: cart.id };
  }

  /** A shown variant's current price, fulfillment and line limit (for this cart); null when it is not shown. */
  private async orderable(variantId: number, cartId?: string) {
    const snapshot = await this.catalog.snapshot();
    const shown = findShown(snapshot, variantId);
    const variant = await this.prisma.variant.findUnique({
      where: { id: variantId },
      select: { price: true, fulfillment: true, active: true },
    });
    if (!shown || !variant?.active) return null;
    const fulfillment = FULFILLMENT[variant.fulfillment];
    const stock = (await availableStock(this.prisma, [variantId], cartId)).get(variantId) ?? 0;
    return { price: variant.price, fulfillment, limit: lineLimit(fulfillment, stock) };
  }

  /** Recomputes every line (spec §3.1): price changes, limits (clamped and saved) and visibility. */
  private async buildView(cartId: string, requestNotices: CartNotice[]): Promise<CartView> {
    const computed = await computeCartLines(this.prisma, cartId, await this.catalog.snapshot());

    const lines: CartLine[] = [];
    const notices: CartNotice[] = [...requestNotices];
    for (const line of computed) {
      const { variantId, available, shown, limit, fulfillment } = line;
      // An unavailable line keeps its saved quantity (shown, but left out of totals and checkout).
      const quantity = available ? line.quantity : line.storedQuantity;

      if (!available) {
        // Shown but nothing left to sell → sold out; no longer shown → unavailable.
        notices.push({
          variantId,
          kind: 'unavailable',
          messageHe: shown ? `${line.modelName} אזל מהמלאי` : `${line.modelName} לא זמין יותר`,
        });
      } else {
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

      lines.push({
        variantId,
        productSlug: line.productSlug,
        modelName: line.modelName,
        nameHe: line.nameHe,
        optionLabels: line.optionLabels,
        image: line.image,
        unitPrice: line.unitPrice,
        compareAtPrice: line.compareAtPrice,
        quantity,
        lineTotal: line.unitPrice * quantity,
        maxQuantity: limit,
        fulfillment,
        leadTimeDays: line.leadTimeDays,
        available,
        // Shown but nothing left to sell → sold out; no longer shown → hidden.
        unavailableReason: available ? null : shown ? 'sold_out' : 'hidden',
      });
    }

    // The one discount (spec §6), on the available lines at the quantities shown. A coupon that does not apply now
    // gets a notice; one that never will again (unknown, expired, used up) is also removed, so its notice shows once.
    const { couponCode } = await this.prisma.cart.findUniqueOrThrow({
      where: { id: cartId },
      select: { couponCode: true },
    });
    const discount = await this.promotions.evaluate(
      this.prisma,
      discountLines(computed, (l) => l.quantity),
      couponCode,
      { cartId },
    );
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

    const counted = lines.filter((l) => l.available);
    return {
      lines,
      itemCount: counted.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: counted.reduce((sum, l) => sum + l.lineTotal, 0),
      deliveryEstimate: deliveryEstimate(lines),
      notices,
      shippingFrom: await this.shipping.shippingFrom(shipmentItems(computed)),
      discount: discount.applied,
      couponCode: code,
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
