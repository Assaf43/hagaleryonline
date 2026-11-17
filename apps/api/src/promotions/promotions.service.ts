import { Injectable } from '@nestjs/common';
import type {
  CartDiscount,
  CouponProblem,
  DiscountType,
  PromotionKind,
  PromotionTarget,
  WelcomeBenefit,
} from '@hg/models';
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
import {
  evaluateDiscount,
  promotionEnded,
  type DiscountLine,
  type DiscountResult,
  type PromotionRule,
} from './discount-engine.js';
import { personalCodeProblem, personalCodeRule, type PersonalCodeState } from './personal-codes.js';

const KIND: Record<DbPromotionKind, PromotionKind> = {
  [DbPromotionKind.AUTOMATIC]: 'automatic',
  [DbPromotionKind.COUPON]: 'coupon',
  [DbPromotionKind.PERSONAL_TEMPLATE]: 'personal_template',
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
 * The cart's account (a signed-in customer, or a store cart's attached customer): personal codes are checked against it
 * (owner; a welcome code only while `hasPaidOrder` is false, decision 93). Guests pass nothing.
 */
export interface WelcomeCustomer {
  customerId: string;
  hasPaidOrder: boolean;
}

export interface EvaluateContext extends UsageExclusion {
  customer?: WelcomeCustomer | null;
  /**
   * The cart is a member's (decision 90: a signed-in account, or a store cart's confirmed customer): members-only
   * promotions are candidates (decision 94). A members-only coupon is then limited to one use per account when
   * `customer` is given (a guest's "what a member would pay" hint passes no customer).
   */
  isMember?: boolean;
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

/** The welcome template now: active, a template, marked welcome, inside its dates (at most one, by a unique index). */
export function welcomeTemplateWhere(now: Date): Prisma.PromotionWhereInput {
  return {
    kind: DbPromotionKind.PERSONAL_TEMPLATE,
    active: true,
    isWelcome: true,
    OR: [{ startsAt: null }, { startsAt: { lte: now } }],
    AND: [{ OR: [{ endsAt: null }, { endsAt: { gte: now } }] }],
  };
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
    membersOnly: p.membersOnly,
    appliesToMemberPrices: p.appliesToMemberPrices,
  };
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

/** The entered code as the engine gets it: the coupon to evaluate, or why the code cannot be used before the engine. */
export interface CouponCandidate {
  coupon: PromotionRule | null;
  /** A personal code's own refusal (owner, use, expiry, first order, spec §5.2), or `unknown` for no such code. */
  problem: CouponProblem | null;
}

/**
 * Promotions read from the database for the discount engine (spec §6). The cart view, coupon entry, checkout and the
 * payment retry all count uses the same way (`withUses`), so the discount the customer sees is the one checkout
 * recomputes (inside its transaction, with `db`).
 *
 * Uses against a limit = paid orders (`usedCount`, +1 per paid order) + live pending orders that hold the promotion
 * (waiting for payment within their reservation), minus the excluded ones (spec §6).
 *
 * Personal codes (decisions 93–94, spec §5.2): an entered code that names no coupon is looked up among the personal
 * codes. It is the coupon candidate — built from its template's current terms (`personalCodeRule`) — only when
 * `personalCodeProblem` finds nothing: the cart's account owns it, it is unused, not expired, its template is active,
 * no other live pending order holds it (one at a time, like the old welcome benefit), and for a welcome code the account
 * has no paid order. A live pending order holds the code through `orders.personal_code_id`; paying it sets the code's
 * `order_id` (`markCodeUsed`).
 */
@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The coupon with this (normalized) code with its uses, or null. With `customerId`, a members-only coupon also gets
   * the account's own uses (`usedByAccount`, once per account, decision 94).
   */
  async coupon(
    db: Db,
    code: string | null,
    exclude: UsageExclusion = {},
    customerId: string | null = null,
  ): Promise<PromotionRule | null> {
    if (!code) return null;
    const found = await db.promotion.findUnique({ where: { code } });
    if (!found) return null;
    const [rule] = await this.withUses(db, [toRule(found)], exclude);
    if (!rule.membersOnly || !customerId) return rule;
    return { ...rule, usedByAccount: await accountUses(db, customerId, rule.id, exclude) };
  }

  /**
   * Active automatic promotions with their uses (dates, minimum and limit are checked by the engine). There is no
   * automatic welcome benefit any more: the welcome template gives each new account a personal code (decision 93).
   */
  async automatic(db: Db, exclude: UsageExclusion = {}): Promise<PromotionRule[]> {
    const rows = await db.promotion.findMany({
      where: { kind: DbPromotionKind.AUTOMATIC, active: true },
      orderBy: { id: 'asc' },
    });
    return this.withUses(db, rows.map(toRule), exclude);
  }

  /**
   * The active welcome template inside its dates, as the checkout banner names it (`labelHe` = its name, as in the
   * cart's discount line when its code is used); null when there is none. Whether a given customer would get a code is
   * not checked here.
   */
  async welcomeBenefit(now = new Date()): Promise<WelcomeBenefit | null> {
    const row = await this.prisma.promotion.findFirst({
      where: welcomeTemplateWhere(now),
      select: { name: true },
    });
    return row ? { labelHe: row.name } : null;
  }

  /** The cart's account with whether it has a paid order (welcome codes); null for a guest. */
  async welcomeCustomer(db: Db, customerId: string | null | undefined): Promise<WelcomeCustomer | null> {
    if (!customerId) return null;
    return { customerId, hasPaidOrder: await hasPaidOrder(db, customerId) };
  }

  /**
   * The personal code an order holds can no longer be honored on a new payment page (retry): its template is off or
   * no longer a template, out of its dates, the code expired, another order used it (paid) or holds it (live pending),
   * the order has no account any more, or — a welcome code — the account has a paid order. Run under the template's
   * row lock (`lockOne`), which the webhook paying an order with a code of this template also takes.
   */
  async personalCodeGone(
    db: Db,
    order: { id: string; customerId: string | null; personalCodeId: number },
    now = new Date(),
  ): Promise<boolean> {
    const state = await this.personalCodeState(db, { id: order.personalCodeId }, { orderId: order.id });
    if (!state) return true;
    if (promotionEnded(state.template, now)) return true;
    // Its own use does not count against it (a paid order is never retried, but the check stays exact).
    const orderId = state.orderId === order.id ? null : state.orderId;
    const customer = await this.welcomeCustomer(db, order.customerId);
    const buyer = {
      customerId: customer?.customerId ?? null,
      isMember: true,
      hasPaidOrder: customer?.hasPaidOrder ?? false,
    };
    return personalCodeProblem({ ...state, orderId }, buyer, now) !== null;
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
    // A members-only coupon too (once per account, decision 94): the webhook paying an order that holds it locks the
    // row for its use +1, so the account's uses read after this lock see that order paid, or still pending.
    // A personal code's template too (spec §5.2): the webhook paying an order that holds a code of this template locks
    // the same row (its use +1) BEFORE it marks the code used, so whatever this checkout reads after this lock — the
    // code's use, the orders holding it, the account's paid orders for a welcome code — sees that payment committed,
    // or the order still pending. The template's terms also stay as read until commit (an admin save locks the row).
    // Two checkouts of one account are already one after the other (the account's advisory lock, `lockWelcome`, taken
    // first), so a second order never takes a code the first holds.
    await tx.$queryRaw`
      SELECT id FROM promotions
      WHERE (usage_limit IS NOT NULL AND (code = ${couponCode} OR (kind = 'automatic' AND active)))
         OR (members_only AND code = ${couponCode})
         OR id = (SELECT promotion_id FROM personal_codes WHERE code = ${couponCode})
      ORDER BY id FOR UPDATE`;
  }

  /** Locks one promotion row (retry: after the order and its variants). */
  async lockOne(tx: Prisma.TransactionClient, id: number): Promise<void> {
    await tx.$queryRaw`SELECT id FROM promotions WHERE id = ${id} FOR UPDATE`;
  }

  /**
   * The entered code (normalized; null: none) as a coupon candidate for this cart: a coupon with its uses, or a usable
   * personal code as a coupon with its template's terms; otherwise why not (`unknown` for a code that names neither).
   * Coupon entry and `evaluate` both use it, with the same exclusions as checkout.
   */
  async candidate(
    db: Db,
    code: string | null,
    context: EvaluateContext = {},
    now = new Date(),
  ): Promise<CouponCandidate> {
    if (!code) return { coupon: null, problem: null };
    const isMember = context.isMember === true;
    const customer = context.customer ?? null;
    const coupon = await this.coupon(db, code, context, isMember ? (customer?.customerId ?? null) : null);
    if (coupon?.kind === 'coupon') return { coupon, problem: null };
    const state = await this.personalCodeState(db, { code }, context);
    if (!state) return { coupon: null, problem: 'unknown' };
    const buyer = { customerId: customer?.customerId ?? null, isMember, hasPaidOrder: customer?.hasPaidOrder ?? false };
    const problem = personalCodeProblem(state, buyer, now);
    return problem ? { coupon: null, problem } : { coupon: personalCodeRule(state), problem: null };
  }

  /**
   * The one discount for these lines and the entered coupon code (null: none): the best automatic promotion against
   * the entered coupon or personal code (`candidate`). A code refused before the engine leaves the automatic promotions
   * alone, with that refusal as the coupon's problem.
   */
  async evaluate(
    db: Db,
    lines: DiscountLine[],
    couponCode: string | null,
    context: EvaluateContext = {},
    now = new Date(),
  ): Promise<DiscountResult & { coupon: PromotionRule | null }> {
    // One after the other: `db` may be an interactive transaction.
    const automatic = await this.automatic(db, context);
    const isMember = context.isMember === true;
    const { coupon, problem } = await this.candidate(db, couponCode, context, now);
    if (problem) {
      const result = evaluateDiscount(lines, automatic, null, now, { isMember });
      return { ...result, couponOutcome: 'invalid', couponProblem: problem, coupon: null };
    }
    return { ...evaluateDiscount(lines, automatic, coupon, now, { isMember }), coupon };
  }

  /**
   * A paid order that holds a personal code marks it used, in the payment transaction after `countUse` (the template's
   * row lock first, then the code's row). A code another paid order already used keeps that first use; this order is
   * honored anyway (a late payment after its reservation ran out, as for a coupon past its limit).
   */
  async markCodeUsed(
    tx: Prisma.TransactionClient,
    order: { id: string; personalCodeId: number | null },
  ): Promise<void> {
    if (order.personalCodeId === null) return;
    await tx.personalCode.updateMany({
      where: { id: order.personalCodeId, orderId: null },
      data: { orderId: order.id },
    });
  }

  /**
   * The account's uses of a promotion (members-only coupons, once per account, decision 94), minus the excluded
   * orders: the payment retry asks with its own order excluded.
   */
  accountUses(db: Db, customerId: string, promotionId: number, exclude: UsageExclusion = {}): Promise<number> {
    return accountUses(db, customerId, promotionId, exclude);
  }

  /** Paid order: one more use of its promotion, even past the limit (the order is honored, Review Focus 5). */
  async countUse(tx: Prisma.TransactionClient, promotionId: number): Promise<void> {
    await tx.promotion.updateMany({ where: { id: promotionId }, data: { usedCount: { increment: 1 } } });
  }

  /** A personal code (by code or id) with its template, use and hold, or null when there is no such code. */
  private async personalCodeState(
    db: Db,
    where: { code: string } | { id: number },
    exclude: UsageExclusion,
  ): Promise<PersonalCodeState | null> {
    const row = await db.personalCode.findUnique({ where, include: { promotion: true } });
    if (!row) return null;
    const held = (await db.order.count({ where: livePending(exclude, { personalCodeId: row.id }) })) > 0;
    return {
      id: row.id,
      code: row.code,
      customerId: row.customerId,
      expiresAt: row.expiresAt,
      orderId: row.orderId,
      held,
      template: toRule(row.promotion),
    };
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
}

/**
 * The account's uses of a promotion (members-only coupons, once per account): its orders holding the promotion that
 * were paid (paid or further along, or cancelled after being paid — as `hasPaidOrder`) plus its live pending ones,
 * minus the excluded ones (the same exclusions as the usage limit).
 */
async function accountUses(db: Db, customerId: string, promotionId: number, exclude: UsageExclusion): Promise<number> {
  const paid = [...PAID_OR_LATER];
  const paidOrders = await db.order.count({
    where: {
      customerId,
      promotionId,
      ...(exclude.orderId ? { id: { not: exclude.orderId } } : {}),
      OR: [
        { status: { in: paid } },
        {
          status: OrderStatus.CANCELLED,
          events: { some: { toStatus: OrderStatus.CANCELLED, fromStatus: { in: paid } } },
        },
      ],
    },
  });
  const pending = await db.order.count({ where: livePending(exclude, { customerId, promotionId }) });
  return paidOrders + pending;
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
