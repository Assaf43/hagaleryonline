import {
  COUPON_MESSAGES_HE,
  couponMinimumMessageHe,
  formatPrice,
  type CartDiscount,
  type CouponProblem,
  type DiscountType,
  type PromotionKind,
  type PromotionTarget,
} from '@hg/models';

/**
 * The discount engine (spec §6, CRT-03, decision 70), pure: no database, no clock of its own.
 *
 * - Eligible lines: every line (target `order`), lines whose category path contains a target category (so a
 *   category includes its sub-categories), or lines of a target product. The base is the line total at the price
 *   charged (after the variant's sale price; the member price for a line at its member price). Shipping is never
 *   discounted — it is not a line. A line at its member price is eligible only for a promotion that applies to
 *   member prices (decision 92): otherwise it is left out, of the minimum too.
 * - Members only (decision 94): a members-only promotion is a candidate only for a member (`isMember`); a members-only
 *   coupon entered without an account is `members_only`, and with an account it works once (`usedByAccount`).
 * - A promotion applies when it is active, `startsAt ≤ now ≤ endsAt` (either may be open), its usage limit is not
 *   reached (`usedCount` is the caller's count: paid orders plus live pending ones, spec §6), the eligible subtotal is
 *   above 0 and at least its minimum, and its amount is above 0.
 * - Amount: percent → round half up to whole shekels, once on the eligible subtotal (never per line); fixed → the
 *   value. Either way never more than the eligible subtotal (only that cap can leave agorot).
 * - One discount per order: the largest automatic promotion (ties → the lower id) against the entered coupon; the
 *   coupon wins only when strictly larger (ties go to the automatic promotion).
 */

export interface PromotionRule {
  id: number;
  name: string;
  kind: PromotionKind;
  /** Upper-case; coupons only. */
  code: string | null;
  discountType: DiscountType;
  /** Percent 1–100, or agorot. */
  value: number;
  target: PromotionTarget;
  targetIds: number[];
  /** Agorot, on the eligible subtotal. */
  minSubtotal: number;
  startsAt: Date | null;
  endsAt: Date | null;
  usageLimit: number | null;
  usedCount: number;
  active: boolean;
  /** The welcome template (decision 93): its personal codes work only while the account has no paid order. */
  isWelcome?: boolean;
  /**
   * A personal code evaluated as a coupon (spec §5.2): the code's id. The rule is then its template's terms with
   * `kind: 'coupon'` and the personal code as `code`; `id` stays the template's.
   */
  personalCodeId?: number;
  /** Only for a signed-in account or a confirmed store customer (decision 94). */
  membersOnly: boolean;
  /** Lines at their member price are eligible too (decision 92); off → they are left out. */
  appliesToMemberPrices: boolean;
  /**
   * Members-only coupons: the account's uses (its paid plus live pending orders holding it, the caller's count);
   * one use and it is `exhausted` for that account. Unset for a guest or any other promotion.
   */
  usedByAccount?: number;
}

/** Who the cart is priced for: a member (account or confirmed store customer) or a guest. */
export interface DiscountContext {
  isMember: boolean;
}

const GUEST: DiscountContext = { isMember: false };

export interface DiscountLine {
  productId: number;
  /** The product's category and every category above it, root first. */
  categoryPathIds: number[];
  /** Agorot: the unit price charged × quantity. */
  lineTotal: number;
  /** The line is priced at its member price (decision 92). */
  atMemberPrice: boolean;
}

/**
 * What happened to the entered coupon: none entered, applied, valid but beaten by an automatic promotion, or
 * not valid (`couponProblem` says why).
 */
export type CouponOutcome = 'none' | 'applied' | 'lost_to_automatic' | 'invalid';

export interface DiscountResult {
  /** The one discount of the order; null when nothing applies. */
  applied: CartDiscount | null;
  /** The promotion behind `applied`. */
  promotion: PromotionRule | null;
  couponOutcome: CouponOutcome;
  /** `lost` when the coupon was beaten; null when the coupon applied or none was entered. */
  couponProblem: CouponProblem | null;
}

/** Subtotal of the lines the promotion targets (agorot). */
export function eligibleSubtotal(rule: PromotionRule, lines: DiscountLine[]): number {
  const targets = new Set(rule.targetIds);
  const eligible = (l: DiscountLine) => {
    if (l.atMemberPrice && !rule.appliesToMemberPrices) return false;
    switch (rule.target) {
      case 'order':
        return true;
      case 'categories':
        return l.categoryPathIds.some((id) => targets.has(id));
      case 'products':
        return targets.has(l.productId);
    }
  };
  return lines.filter(eligible).reduce((sum, l) => sum + l.lineTotal, 0);
}

/** The discount the promotion gives on these lines, ignoring its eligibility rules (agorot). */
export function discountAmount(rule: PromotionRule, lines: DiscountLine[]): number {
  return amountOn(rule, eligibleSubtotal(rule, lines));
}

function amountOn(rule: PromotionRule, base: number): number {
  // Percent: base × value / 100 agorot, rounded half up to a multiple of 100 agorot (whole shekels).
  const raw = rule.discountType === 'percent' ? Math.floor((base * rule.value + 5_000) / 10_000) * 100 : rule.value;
  return Math.max(0, Math.min(raw, base));
}

/** Why the promotion does not apply to an eligible subtotal of `eligible` now; null when it does. */
function ruleProblem(
  rule: PromotionRule,
  eligible: number,
  now: Date,
  context: DiscountContext = GUEST,
): Exclude<CouponProblem, 'unknown' | 'lost' | 'lost_to_member_prices'> | null {
  if (rule.membersOnly && !context.isMember) return 'members_only';
  if (!rule.active) return 'expired';
  if (rule.startsAt && now < rule.startsAt) return 'not_started';
  if (rule.endsAt && now > rule.endsAt) return 'expired';
  if (rule.usageLimit !== null && rule.usedCount >= rule.usageLimit) return 'exhausted';
  // Once per account (decision 94).
  if (rule.membersOnly && rule.kind === 'coupon' && (rule.usedByAccount ?? 0) >= 1) return 'exhausted';
  if (eligible <= 0) return 'not_applicable';
  if (eligible < rule.minSubtotal) return 'below_minimum';
  if (amountOn(rule, eligible) <= 0) return 'not_applicable';
  return null;
}

/** Not active, out of its dates or used up (by `usedCount`): an order holding it may not be paid again (retry). */
export function promotionEnded(rule: PromotionRule, now: Date): boolean {
  // As a member: whether the order may still use it is about the promotion, not about who pays (the order has it).
  const problem = ruleProblem({ ...rule, usedByAccount: undefined }, Number.MAX_SAFE_INTEGER, now, { isMember: true });
  return problem === 'not_started' || problem === 'expired' || problem === 'exhausted';
}

/** Why an entered coupon gives no discount (null: it is valid); `rule` is null when no coupon has that code. */
export function couponProblem(
  rule: PromotionRule | null,
  eligible: number,
  now: Date,
  context: DiscountContext = GUEST,
): CouponProblem | null {
  if (!rule || rule.kind !== 'coupon') return 'unknown';
  return ruleProblem(rule, eligible, now, context);
}

/** The Hebrew message of a coupon problem (spec §6). */
export function couponProblemMessageHe(problem: CouponProblem, rule: PromotionRule | null): string {
  if (problem === 'below_minimum') return couponMinimumMessageHe(formatPrice(rule?.minSubtotal ?? 0));
  return COUPON_MESSAGES_HE[problem];
}

/** The Hebrew error for an entered coupon, or null when it is valid (`eligible`: its eligible subtotal). */
export function couponError(
  rule: PromotionRule | null,
  eligible: number,
  now: Date,
  context: DiscountContext = GUEST,
): string | null {
  const problem = couponProblem(rule, eligible, now, context);
  return problem ? couponProblemMessageHe(problem, rule) : null;
}

/**
 * The one discount of the order: the best automatic promotion or the coupon (spec §6). `context`: a guest unless
 * given — members-only promotions are then never candidates.
 */
export function evaluateDiscount(
  lines: DiscountLine[],
  promotions: PromotionRule[],
  coupon: PromotionRule | null,
  now: Date,
  context: DiscountContext = GUEST,
): DiscountResult {
  let best: { rule: PromotionRule; amount: number } | null = null;
  for (const rule of [...promotions].sort((a, b) => a.id - b.id)) {
    if (rule.kind !== 'automatic') continue;
    const eligible = eligibleSubtotal(rule, lines);
    if (ruleProblem(rule, eligible, now, context)) continue;
    const amount = amountOn(rule, eligible);
    if (amount > 0 && (!best || amount > best.amount)) best = { rule, amount };
  }

  let couponOutcome: CouponOutcome = 'none';
  let problem: CouponProblem | null = null;
  if (coupon) {
    const eligible = eligibleSubtotal(coupon, lines);
    problem = couponProblem(coupon, eligible, now, context);
    if (problem) couponOutcome = 'invalid';
    else {
      const amount = amountOn(coupon, eligible);
      if (best && best.amount >= amount) {
        couponOutcome = 'lost_to_automatic';
        problem = 'lost';
      } else {
        couponOutcome = 'applied';
        best = { rule: coupon, amount };
      }
    }
  }

  if (!best) return { applied: null, promotion: null, couponOutcome, couponProblem: problem };
  const { rule, amount } = best;
  // Only automatic promotions and coupons (a personal code is evaluated as a coupon) reach here.
  const isCoupon = rule.kind === 'coupon';
  return {
    applied: {
      labelHe: rule.name,
      amount,
      source: isCoupon ? 'coupon' : 'automatic',
      code: isCoupon ? rule.code : null,
    },
    promotion: rule,
    couponOutcome,
    couponProblem: problem,
  };
}
