import type { CartPricingKind } from '@hg/models';
import type { DiscountLine, DiscountResult } from './discount-engine.js';

/**
 * The one pricing function of a cart (spec §5.1, decision 92): the cart view, the website checkout and the store
 * checkout all turn unit prices into line totals, subtotal, discount and total here, and nowhere else. Pure: the
 * caller's `evaluate` runs the discount engine (with the database's promotions) on the lines it is given.
 *
 * - A guest (`isMember: false`): regular prices on every line, one evaluation.
 * - A member (a signed-in account, or a store cart's confirmed customer): two evaluations of the whole cart —
 *   (a) member prices on the lines that have one (`atMemberPrice`), regular prices on the others;
 *   (b) regular prices on every line —
 *   each with its one best discount (decision 70); the lower `subtotal − discount` wins, a tie goes to member pricing.
 *   A cart without any member price is just (b), reported as `regular`.
 *
 * Totals are before shipping. Money in agorot.
 */

export interface PricingLine {
  productId: number;
  /** The product's category and every category above it, root first. */
  categoryPathIds: number[];
  /** The quantity bought (the caller's: clamped for the cart view, stored for checkout). */
  quantity: number;
  /** The current regular unit price (after the variant's sale price). */
  price: number;
  /** The variant's member price; null when it has none. */
  memberPrice: number | null;
}

export interface PricedLine {
  /** The unit price charged. */
  unitPrice: number;
  /** `unitPrice` is the member price. */
  atMemberPrice: boolean;
  /** `unitPrice × quantity`. */
  lineTotal: number;
}

export interface CartPricing<D extends DiscountResult = DiscountResult> {
  pricing: CartPricingKind;
  /** In the order of the input lines. */
  lines: PricedLine[];
  subtotal: number;
  /** The winning run's evaluation. */
  discount: D;
  /** `subtotal − discount`, before shipping. */
  total: number;
}

export interface PriceCartInput<D extends DiscountResult> {
  lines: PricingLine[];
  isMember: boolean;
  /** The discount engine on these lines (called once for a guest, at most twice for a member, one after the other). */
  evaluate: (lines: DiscountLine[]) => Promise<D>;
}

export async function priceCart<D extends DiscountResult>(input: PriceCartInput<D>): Promise<CartPricing<D>> {
  const { lines, isMember, evaluate } = input;
  const regular = await run(
    lines.map((l) => priced(l, false)),
    lines,
    evaluate,
    'regular',
  );
  if (!isMember || !lines.some((l) => l.memberPrice !== null)) return regular;
  const member = await run(
    lines.map((l) => priced(l, l.memberPrice !== null)),
    lines,
    evaluate,
    'member',
  );
  if (member.total > regular.total) return regular;
  return { ...member, discount: couponBeaten(member.discount, regular.discount) };
}

/**
 * The guest hint (spec §9): what a member would pay less for the same cart — `guest.total − member.total` — or null
 * when a member would not pay less. `member` is the same cart priced with `isMember: true`.
 */
export function memberSavings(guest: CartPricing, member: CartPricing): number | null {
  const savings = guest.total - member.total;
  return savings > 0 ? savings : null;
}

/** Every line at its regular price, as the engine sees it (coupon entry: the most lenient eligibility). */
export function regularDiscountLines(lines: PricingLine[]): DiscountLine[] {
  return lines.map((l) => discountLine(l, priced(l, false)));
}

/** A line left out of the totals (unavailable), shown at its regular price. */
export function unpricedLine(price: number, quantity: number): PricedLine {
  return { unitPrice: price, atMemberPrice: false, lineTotal: price * quantity };
}

function priced(line: PricingLine, atMemberPrice: boolean): PricedLine {
  const unitPrice = atMemberPrice ? line.memberPrice! : line.price;
  return { unitPrice, atMemberPrice, lineTotal: unitPrice * line.quantity };
}

function discountLine(line: PricingLine, p: PricedLine): DiscountLine {
  return {
    productId: line.productId,
    categoryPathIds: line.categoryPathIds,
    lineTotal: p.lineTotal,
    atMemberPrice: p.atMemberPrice,
  };
}

async function run<D extends DiscountResult>(
  pricedLines: PricedLine[],
  lines: PricingLine[],
  evaluate: (lines: DiscountLine[]) => Promise<D>,
  pricing: CartPricingKind,
): Promise<CartPricing<D>> {
  const discount = await evaluate(pricedLines.map((p, i) => discountLine(lines[i], p)));
  const subtotal = pricedLines.reduce((sum, l) => sum + l.lineTotal, 0);
  return { pricing, lines: pricedLines, subtotal, discount, total: subtotal - (discount.applied?.amount ?? 0) };
}

/**
 * Member pricing won but the entered coupon failed there for a reason that depends on the lines (it does not apply to
 * member prices, or their lower subtotal is below its minimum): the coupon is reported as the regular run saw it, as
 * coupon entry checks it — valid there (applied, or beaten by an automatic promotion) → `lost` (beaten by member
 * pricing); invalid there too → that run's reason.
 */
function couponBeaten<D extends DiscountResult>(winner: D, regular: D): D {
  if (winner.couponOutcome !== 'invalid' || !LINE_PROBLEMS.has(winner.couponProblem)) return winner;
  if (regular.couponOutcome === 'invalid') return { ...winner, couponProblem: regular.couponProblem };
  return { ...winner, couponOutcome: 'lost_to_automatic', couponProblem: 'lost' };
}

const LINE_PROBLEMS: ReadonlySet<DiscountResult['couponProblem']> = new Set(['not_applicable', 'below_minimum']);
