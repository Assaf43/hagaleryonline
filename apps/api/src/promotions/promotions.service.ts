import { Injectable } from '@nestjs/common';
import type { CartDiscount, DiscountType, PromotionKind, PromotionTarget, WelcomeBenefit } from '@hg/models';
import type { ComputedLine } from '../cart/cart-lines.js';
import {
  OrderStatus,
  DiscountType as DbDiscountType,
  PromotionKind as DbPromotionKind,
  PromotionTarget as DbPromotionTarget,
  type Prisma,
  type Promotion,
} from '../generated/prisma/client.js';
import { PAID_OR_LATER } from '../orders/order-transitions.js';
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

/**
 * The signed-in customer, for the welcome benefit (decision 79): it is a candidate only for `hasPaidOrder: false`.
 * Guests pass nothing and never get it.
 */
export interface WelcomeCustomer {
  customerId: string;
  hasPaidOrder: boolean;
}

export interface EvaluateContext extends UsageExclusion {
  customer?: WelcomeCustomer | null;
}

/**
 * The account has a paid order: one paid or further along the flow (`PAID_OR_LATER`), or cancelled after it was paid
 * (a status event from a paid status to cancelled). An order cancelled while unpaid (even if a late payment was then
 * refunded) does not count. Only the account's own orders: guest orders are never linked (decision 77).
 */
export async function hasPaidOrder(db: Db, customerId: string): Promise<boolean> {
  const paid = [...PAID_OR_LATER];
  const found = await db.order.findFirst({
    where: {
      customerId,
      OR: [
        { status: { in: paid } },
        {
          status: OrderStatus.CANCELLED,
          events: { some: { toStatus: OrderStatus.CANCELLED, fromStatus: { in: paid } } },
        },
      ],
    },
    select: { id: true },
  });
  return found !== null;
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
    isWelcome: p.isWelcome,
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

  /**
   * Active automatic promotions with their uses (dates, minimum and limit are checked by the engine). The welcome
   * benefit is not among them: `evaluate` adds it for an eligible customer only.
   */
  async automatic(db: Db, exclude: UsageExclusion = {}): Promise<PromotionRule[]> {
    const rows = await db.promotion.findMany({
      where: { kind: DbPromotionKind.AUTOMATIC, active: true, isWelcome: false },
      orderBy: { id: 'asc' },
    });
    return this.withUses(db, rows.map(toRule), exclude);
  }

  /**
   * The active welcome promotion inside its dates, as the checkout banner names it (`labelHe` = its name, as in the
   * cart's discount line); null when there is none. Whether a given customer would get it is not checked here.
   */
  async welcomeBenefit(now = new Date()): Promise<WelcomeBenefit | null> {
    const row = await this.prisma.promotion.findFirst({
      where: {
        kind: DbPromotionKind.AUTOMATIC,
        active: true,
        isWelcome: true,
        OR: [{ startsAt: null }, { startsAt: { lte: now } }],
        AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
      },
      select: { name: true },
    });
    return row ? { labelHe: row.name } : null;
  }

  /** The signed-in customer's eligibility for the welcome benefit; null for a guest. */
  async welcomeCustomer(db: Db, customerId: string | null | undefined): Promise<WelcomeCustomer | null> {
    if (!customerId) return null;
    return { customerId, hasPaidOrder: await hasPaidOrder(db, customerId) };
  }

  /**
   * The welcome benefit of an order can still be honored (retry): the order has an account, the account has no paid
   * order, and no other live pending order of the account holds the benefit.
   */
  async welcomeStillOpen(
    db: Db,
    order: { id: string; customerId: string | null; promotionId: number },
  ): Promise<boolean> {
    if (!order.customerId || (await hasPaidOrder(db, order.customerId))) return false;
    return !(await this.welcomeHeld(db, order.customerId, order.promotionId, { orderId: order.id }));
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
  async lockLimited(tx: Prisma.TransactionClient, couponCode: string | null, welcome = false): Promise<void> {
    // With `welcome` (any signed-in checkout), the active welcome promotion too (in the same id order), so it cannot
    // change until commit and a webhook paying a welcome order (it locks the row for its use +1) is waited for before
    // the checkout reads `hasPaidOrder` (CheckoutService).
    await tx.$queryRaw`
      SELECT id FROM promotions
      WHERE (usage_limit IS NOT NULL AND (code = ${couponCode} OR (kind = 'automatic' AND active)))
         OR (${welcome} AND is_welcome AND active)
      ORDER BY id FOR UPDATE`;
  }

  /** Locks one promotion row (retry: after the order and its variants). */
  async lockOne(tx: Prisma.TransactionClient, id: number): Promise<void> {
    await tx.$queryRaw`SELECT id FROM promotions WHERE id = ${id} FOR UPDATE`;
  }

  /**
   * The one discount for these lines and the entered coupon code (null: none). The active welcome promotion is a
   * candidate only when `context.customer` is given with `hasPaidOrder: false`, and only while no other live pending
   * order of that account holds it (then `welcomeHeld` is true: checkout answers 409 `promotion_ended` when the
   * customer saw it). Otherwise it follows the rules of any automatic promotion (one discount, best wins).
   */
  async evaluate(
    db: Db,
    lines: DiscountLine[],
    couponCode: string | null,
    context: EvaluateContext = {},
    now = new Date(),
  ): Promise<DiscountResult & { coupon: PromotionRule | null; welcomeHeld: boolean }> {
    // One after the other: `db` may be an interactive transaction.
    const automatic = await this.automatic(db, context);
    let welcomeHeld = false;
    const customer = context.customer;
    if (customer && !customer.hasPaidOrder) {
      const row = await db.promotion.findFirst({
        where: { kind: DbPromotionKind.AUTOMATIC, active: true, isWelcome: true },
      });
      if (row && (await this.welcomeHeld(db, customer.customerId, row.id, context))) welcomeHeld = true;
      else if (row) automatic.push(...(await this.withUses(db, [toRule(row)], context)));
    }
    const coupon = await this.coupon(db, couponCode, context);
    if (couponCode && coupon?.kind !== 'coupon') {
      // An entered code that names no coupon (any more): the automatic promotions alone, the code is unknown.
      const result = evaluateDiscount(lines, automatic, null, now);
      return { ...result, couponOutcome: 'invalid', couponProblem: 'unknown', coupon: null, welcomeHeld };
    }
    return { ...evaluateDiscount(lines, automatic, coupon, now), coupon, welcomeHeld };
  }

  /** Paid order: one more use of its promotion, even past the limit (the order is honored, Review Focus 5). */
  async countUse(tx: Prisma.TransactionClient, promotionId: number): Promise<void> {
    await tx.promotion.updateMany({ where: { id: promotionId }, data: { usedCount: { increment: 1 } } });
  }

  /** `usedCount` of each limited rule becomes paid uses + live pending orders holding it (minus the excluded). */
  private async withUses(db: Db, rules: PromotionRule[], exclude: UsageExclusion): Promise<PromotionRule[]> {
    const limited = rules.filter((r) => r.usageLimit !== null).map((r) => r.id);
    if (limited.length === 0) return rules;
    const where = livePending(exclude, { promotionId: { in: limited } });
    const pending = await db.order.groupBy({ by: ['promotionId'], where, _count: { _all: true } });
    const counts = new Map(pending.map((p) => [p.promotionId, p._count._all]));
    return rules.map((r) => ({ ...r, usedCount: r.usedCount + (counts.get(r.id) ?? 0) }));
  }

  /** Another live pending order of the account (not excluded) holds the welcome promotion: one at a time. */
  private async welcomeHeld(
    db: Db,
    customerId: string,
    promotionId: number,
    exclude: UsageExclusion,
  ): Promise<boolean> {
    return (await db.order.count({ where: livePending(exclude, { customerId, promotionId }) })) > 0;
  }
}

/** Orders waiting for payment within their reservation, matching `extra`, minus the excluded ones. */
function livePending(exclude: UsageExclusion, extra: Prisma.OrderWhereInput): Prisma.OrderWhereInput {
  const where: Prisma.OrderWhereInput = {
    ...extra,
    status: OrderStatus.PENDING_PAYMENT,
    reservedUntil: { gt: new Date() },
  };
  // Not `NOT: { cartId }`: on a nullable column it also drops the orders whose cart is gone (cart_id NULL).
  const and: Prisma.OrderWhereInput[] = [];
  if (exclude.cartId) and.push({ OR: [{ cartId: null }, { cartId: { not: exclude.cartId } }] });
  if (exclude.orderId) and.push({ id: { not: exclude.orderId } });
  if (and.length > 0) where.AND = and;
  return where;
}

type Db = Prisma.TransactionClient | PrismaService;
