import { Injectable } from '@nestjs/common';
import type { CartDiscount, DiscountType, PromotionKind, PromotionTarget } from '@hg/models';
import type { ComputedLine } from '../cart/cart-lines.js';
import {
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

/** Codes are case-insensitive: stored and compared upper-case, without surrounding spaces. */
export function normalizeCouponCode(code: string): string {
  return code.trim().toUpperCase();
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
 * Promotions read from the database for the discount engine (spec §6). The cart view and checkout both go through
 * `evaluate`, so the discount the customer sees is the one checkout recomputes (inside its transaction, with `db`).
 */
@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The coupon with this (normalized) code, or null. */
  async coupon(db: Prisma.TransactionClient | PrismaService, code: string | null): Promise<PromotionRule | null> {
    if (!code) return null;
    const found = await db.promotion.findUnique({ where: { code } });
    return found ? toRule(found) : null;
  }

  /** Active automatic promotions (dates, minimum and limit are checked by the engine). */
  async automatic(db: Prisma.TransactionClient | PrismaService): Promise<PromotionRule[]> {
    const rows = await db.promotion.findMany({
      where: { kind: DbPromotionKind.AUTOMATIC, active: true },
      orderBy: { id: 'asc' },
    });
    return rows.map(toRule);
  }

  /** The one discount for these lines and the entered coupon code (null: none). */
  async evaluate(
    db: Prisma.TransactionClient | PrismaService,
    lines: DiscountLine[],
    couponCode: string | null,
    now = new Date(),
  ): Promise<DiscountResult & { coupon: PromotionRule | null }> {
    // One after the other: `db` may be an interactive transaction.
    const automatic = await this.automatic(db);
    const coupon = await this.coupon(db, couponCode);
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
}
