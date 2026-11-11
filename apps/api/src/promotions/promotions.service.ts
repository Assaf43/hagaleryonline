import { Injectable } from '@nestjs/common';
import type { CartDiscount, DiscountType, PromotionKind, PromotionTarget } from '@hg/models';
import type { ComputedLine } from '../cart/cart-lines.js';
import {
  OrderStatus,
  DiscountType as DbDiscountType,
  PromotionKind as DbPromotionKind,
  PromotionTarget as DbPromotionTarget,
  type Prisma,
  type Promotion,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { evaluateDiscount, type DiscountLine, type DiscountResult, type PromotionRule } from './discount-engine.js';

const KIND: Record<DbPromotionKind, PromotionKind> = {
  [DbPromotionKind.AUTOMATIC]: 'automatic',
  [DbPromotionKind.COUPON]: 'coupon',
};
const DISCOUNT_TYPE: Record<DbDiscountType, DiscountType> = {
  [DbDiscountType.PERCENT]: 'percent',
  [DbDiscountType.FIXED]: 'fixed',
};
const TARGET: Record<DbPromotionTarget, PromotionTarget> = {
  [DbPromotionTarget.ORDER]: 'order',
  [DbPromotionTarget.CATEGORIES]: 'categories',
  [DbPromotionTarget.PRODUCTS]: 'products',
};

/** Longest coupon code accepted from a customer (characters, after trimming). */
export const MAX_COUPON_CODE = 64;

/** The order snapshot of the applied promotion (`orders.discount_info`, spec §6). */
export interface DiscountInfo {
  name: string;
  kind: PromotionKind;
  code: string | null;
  labelHe: string;
  source: CartDiscount['source'];
}

/** Codes are compared in one normalized form (`@hg/models`): NFKC, no bidi/zero-width marks, trimmed, upper-case. */
export { normalizeCouponCode } from '@hg/models';

/**
 * Orders whose use of a promotion is not counted against its limit: the cart's own pending orders (a new checkout
 * of that cart replaces them) and, for a retry, the order itself.
 */
export interface UsageExclusion {
  cartId?: string | null;
  orderId?: string;
}

export function toRule(p: Promotion): PromotionRule {
  return {
    id: p.id,
    name: p.name,
    kind: KIND[p.kind],
    code: p.code,
    discountType: DISCOUNT_TYPE[p.discountType],
    value: p.value,
    target: TARGET[p.target],
    targetIds: p.targetIds,
    minSubtotal: p.minSubtotal,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    usageLimit: p.usageLimit,
    usedCount: p.usedCount,
    active: p.active,
  };
}

/** The available lines of a cart as the engine sees them: current price × the quantity that can be bought. */
export function discountLines(lines: ComputedLine[], quantity: (l: ComputedLine) => number): DiscountLine[] {
  return lines
    .filter((l) => l.available)
    .map((l) => ({ productId: l.productId, categoryPathIds: l.categoryPathIds, lineTotal: l.unitPrice * quantity(l) }));
}

export function discountInfo(result: DiscountResult): DiscountInfo | null {
  const { applied, promotion } = result;
  if (!applied || !promotion) return null;
  return {
    name: promotion.name,
    kind: promotion.kind,
    code: promotion.code,
    labelHe: applied.labelHe,
    source: applied.source,
  };
}

/**
 * Promotions read from the database for the discount engine (spec §6). The cart view, coupon entry, checkout and the
 * payment retry all count uses the same way (`withUses`), so the discount the customer sees is the one checkout
 * recomputes (inside its transaction, with `db`).
 *
 * Uses against a limit = paid orders (`usedCount`, +1 per paid order) + live pending orders that hold the promotion
 * (waiting for payment within their reservation), minus the excluded ones (spec §6).
 */
@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The coupon with this (normalized) code with its uses, or null. */
  async coupon(db: Db, code: string | null, exclude: UsageExclusion = {}): Promise<PromotionRule | null> {
    if (!code) return null;
    const found = await db.promotion.findUnique({ where: { code } });
    return found ? (await this.withUses(db, [toRule(found)], exclude))[0] : null;
  }

  /** Active automatic promotions with their uses (dates, minimum and limit are checked by the engine). */
  async automatic(db: Db, exclude: UsageExclusion = {}): Promise<PromotionRule[]> {
    const rows = await db.promotion.findMany({
      where: { kind: DbPromotionKind.AUTOMATIC, active: true },
      orderBy: { id: 'asc' },
    });
    return this.withUses(db, rows.map(toRule), exclude);
  }

  /** One promotion by id with its uses (retry of an order), or null. */
  async byId(db: Db, id: number, exclude: UsageExclusion = {}): Promise<PromotionRule | null> {
    const found = await db.promotion.findUnique({ where: { id } });
    return found ? (await this.withUses(db, [toRule(found)], exclude))[0] : null;
  }

  /**
   * Locks the rows of the limited promotions a checkout may use — the coupon and the active automatic ones with a
   * usage limit — in id order, so their uses stay true until commit. Taken LAST: cart → orders → variants →
   * promotions (locks.ts).
   */
  async lockLimited(tx: Prisma.TransactionClient, couponCode: string | null): Promise<void> {
    await tx.$queryRaw`
      SELECT id FROM promotions
      WHERE usage_limit IS NOT NULL AND (code = ${couponCode} OR (kind = 'automatic' AND active))
      ORDER BY id FOR UPDATE`;
  }

  /** Locks one promotion row (retry: after the order and its variants). */
  async lockOne(tx: Prisma.TransactionClient, id: number): Promise<void> {
    await tx.$queryRaw`SELECT id FROM promotions WHERE id = ${id} FOR UPDATE`;
  }

  /** The one discount for these lines and the entered coupon code (null: none). */
  async evaluate(
    db: Db,
    lines: DiscountLine[],
    couponCode: string | null,
    exclude: UsageExclusion = {},
    now = new Date(),
  ): Promise<DiscountResult & { coupon: PromotionRule | null }> {
    // One after the other: `db` may be an interactive transaction.
    const automatic = await this.automatic(db, exclude);
    const coupon = await this.coupon(db, couponCode, exclude);
    if (couponCode && coupon?.kind !== 'coupon') {
      // An entered code that names no coupon (any more): the automatic promotions alone, the code is unknown.
      const result = evaluateDiscount(lines, automatic, null, now);
      return { ...result, couponOutcome: 'invalid', couponProblem: 'unknown', coupon: null };
    }
    return { ...evaluateDiscount(lines, automatic, coupon, now), coupon };
  }

  /** Paid order: one more use of its promotion, even past the limit (the order is honored, Review Focus 5). */
  async countUse(tx: Prisma.TransactionClient, promotionId: number): Promise<void> {
    await tx.promotion.updateMany({ where: { id: promotionId }, data: { usedCount: { increment: 1 } } });
  }

  /** `usedCount` of each limited rule becomes paid uses + live pending orders holding it (minus the excluded). */
  private async withUses(db: Db, rules: PromotionRule[], exclude: UsageExclusion): Promise<PromotionRule[]> {
    const limited = rules.filter((r) => r.usageLimit !== null).map((r) => r.id);
    if (limited.length === 0) return rules;
    const where: Prisma.OrderWhereInput = {
      promotionId: { in: limited },
      status: OrderStatus.PENDING_PAYMENT,
      reservedUntil: { gt: new Date() },
    };
    // Not `NOT: { cartId }`: on a nullable column it also drops the orders whose cart is gone (cart_id NULL).
    const and: Prisma.OrderWhereInput[] = [];
    if (exclude.cartId) and.push({ OR: [{ cartId: null }, { cartId: { not: exclude.cartId } }] });
    if (exclude.orderId) and.push({ id: { not: exclude.orderId } });
    if (and.length > 0) where.AND = and;
    const pending = await db.order.groupBy({ by: ['promotionId'], where, _count: { _all: true } });
    const counts = new Map(pending.map((p) => [p.promotionId, p._count._all]));
    return rules.map((r) => ({ ...r, usedCount: r.usedCount + (counts.get(r.id) ?? 0) }));
  }
}

type Db = Prisma.TransactionClient | PrismaService;
