import { vi } from 'vitest';
import { memberSavings, priceCart, regularDiscountLines, unpricedLine, type PricingLine } from './cart-pricing.js';
import { evaluateDiscount, type DiscountLine, type PromotionRule } from './discount-engine.js';

const NOW = new Date('2026-11-16T12:00:00Z');

let nextId = 1;
function rule(patch: Partial<PromotionRule> = {}): PromotionRule {
  return {
    id: nextId++,
    name: 'מבצע',
    kind: 'automatic',
    code: null,
    discountType: 'percent',
    value: 20,
    target: 'order',
    targetIds: [],
    minSubtotal: 0,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usedCount: 0,
    active: true,
    membersOnly: false,
    appliesToMemberPrices: false,
    ...patch,
  };
}

const pricing = (patch: Partial<PricingLine> & Pick<PricingLine, 'price'>): PricingLine => ({
  productId: 1,
  categoryPathIds: [10],
  quantity: 1,
  memberPrice: null,
  ...patch,
});

/** The engine with these promotions and coupon, for a member or a guest. */
const engine = (isMember: boolean, automatic: PromotionRule[], coupon: PromotionRule | null = null) =>
  vi.fn((lines: DiscountLine[]) => Promise.resolve(evaluateDiscount(lines, automatic, coupon, NOW, { isMember })));

/** 5,000 ₪, member price 4,500 ₪ (the builder check, decision 92). */
const SOFA = pricing({ productId: 1, price: 500_000, memberPrice: 450_000 });
/** 1,000 ₪, no member price. */
const TABLE = pricing({ productId: 2, categoryPathIds: [20], price: 100_000 });

describe('priceCart: best of two (decision 92, spec §5.1)', () => {
  it('a guest pays regular prices, evaluated once', async () => {
    const evaluate = engine(false, [rule()]);
    const result = await priceCart({ lines: [SOFA], isMember: false, evaluate });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate.mock.calls[0][0]).toEqual([
      { productId: 1, categoryPathIds: [10], lineTotal: 500_000, atMemberPrice: false },
    ]);
    expect(result).toMatchObject({
      pricing: 'regular',
      lines: [{ unitPrice: 500_000, atMemberPrice: false, lineTotal: 500_000 }],
      subtotal: 500_000,
      total: 400_000,
    });
    expect(result.discount.applied?.amount).toBe(100_000);
  });

  it('switch off: 20% on the regular price beats the member price — 4,000 ₪ with pricing regular', async () => {
    const result = await priceCart({ lines: [SOFA], isMember: true, evaluate: engine(true, [rule()]) });
    expect(result).toMatchObject({
      pricing: 'regular',
      lines: [{ unitPrice: 500_000, atMemberPrice: false, lineTotal: 500_000 }],
      subtotal: 500_000,
      total: 400_000,
    });
    expect(result.discount.applied?.amount).toBe(100_000);
  });

  it('switch on: 20% on the member price — 3,600 ₪ with pricing member', async () => {
    const evaluate = engine(true, [rule({ appliesToMemberPrices: true })]);
    const result = await priceCart({ lines: [SOFA], isMember: true, evaluate });
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      pricing: 'member',
      lines: [{ unitPrice: 450_000, atMemberPrice: true, lineTotal: 450_000 }],
      subtotal: 450_000,
      total: 360_000,
    });
    expect(result.discount.applied?.amount).toBe(90_000);
  });

  it('a member with no promotion pays the member price', async () => {
    const result = await priceCart({ lines: [{ ...SOFA, quantity: 2 }], isMember: true, evaluate: engine(true, []) });
    expect(result).toMatchObject({
      pricing: 'member',
      lines: [{ unitPrice: 450_000, atMemberPrice: true, lineTotal: 900_000 }],
      subtotal: 900_000,
      total: 900_000,
    });
    expect(result.discount.applied).toBeNull();
  });

  it('mixed cart: only the lines with a member price change, the promotion counts the eligible lines', async () => {
    // Member run: 4,500 + 1,000 − 5% of 1,000 (the table only) = 5,450 ₪; regular run: 6,000 − 5% = 5,700 ₪.
    const result = await priceCart({
      lines: [SOFA, TABLE],
      isMember: true,
      evaluate: engine(true, [rule({ value: 5 })]),
    });
    expect(result).toMatchObject({
      pricing: 'member',
      lines: [
        { unitPrice: 450_000, atMemberPrice: true, lineTotal: 450_000 },
        { unitPrice: 100_000, atMemberPrice: false, lineTotal: 100_000 },
      ],
      subtotal: 550_000,
      total: 545_000,
    });
    expect(result.discount.applied?.amount).toBe(5_000);
  });

  it('the minimum is counted on the eligible lines only', async () => {
    // 100 ₪ off from 2,000 ₪: the member run's eligible lines (the table, 1,000 ₪) are below it → 5,500 ₪;
    // the regular run gets it → 5,900 ₪. The member run wins without a discount.
    const min = rule({ discountType: 'fixed', value: 10_000, minSubtotal: 200_000 });
    const result = await priceCart({ lines: [SOFA, TABLE], isMember: true, evaluate: engine(true, [min]) });
    expect(result).toMatchObject({ pricing: 'member', subtotal: 550_000, total: 550_000 });
    expect(result.discount.applied).toBeNull();
  });

  it('tie → member pricing', async () => {
    // Member run: 5,500 − 10% of 1,000 = 5,400 ₪; regular run: 6,000 − 10% = 5,400 ₪.
    const result = await priceCart({
      lines: [SOFA, TABLE],
      isMember: true,
      evaluate: engine(true, [rule({ value: 10 })]),
    });
    expect(result).toMatchObject({ pricing: 'member', subtotal: 550_000, total: 540_000 });
    expect(result.lines.map((l) => l.atMemberPrice)).toEqual([true, false]);
  });

  it('a cart without member prices is regular pricing for a member, evaluated once', async () => {
    const evaluate = engine(true, [rule()]);
    const result = await priceCart({ lines: [TABLE], isMember: true, evaluate });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ pricing: 'regular', subtotal: 100_000, total: 80_000 });
  });

  it('a members-only automatic promotion is ignored for a guest', async () => {
    const members = rule({ membersOnly: true, appliesToMemberPrices: true });
    const guest = await priceCart({ lines: [TABLE], isMember: false, evaluate: engine(false, [members]) });
    expect(guest).toMatchObject({ pricing: 'regular', total: 100_000 });
    const member = await priceCart({ lines: [TABLE], isMember: true, evaluate: engine(true, [members]) });
    expect(member.total).toBe(80_000);
  });

  it('the member run winning over a coupon that only fits regular prices reports the coupon as lost', async () => {
    // 10% coupon, switch off, on a cart of member-price lines only: member run 4,500 ₪ (coupon not applicable),
    // regular run 4,500 ₪ (5,000 − 500): tie → member, and the coupon is beaten, not "not applicable".
    const code = rule({ kind: 'coupon', code: 'SAVE', value: 10 });
    const result = await priceCart({ lines: [SOFA], isMember: true, evaluate: engine(true, [], code) });
    expect(result).toMatchObject({ pricing: 'member', total: 450_000 });
    expect(result.discount).toMatchObject({ applied: null, couponOutcome: 'lost_to_automatic', couponProblem: 'lost' });
  });

  it('a coupon the regular run cannot use either keeps its own problem', async () => {
    const code = rule({ kind: 'coupon', code: 'SAVE', value: 10, minSubtotal: 900_000 });
    const result = await priceCart({ lines: [SOFA], isMember: true, evaluate: engine(true, [], code) });
    expect(result.discount.couponProblem).toBe('below_minimum');
  });

  it('an empty cart is zero', async () => {
    const result = await priceCart({ lines: [], isMember: true, evaluate: engine(true, [rule()]) });
    expect(result).toMatchObject({ pricing: 'regular', lines: [], subtotal: 0, total: 0 });
  });
});

describe('memberSavings (guest hint, spec §9)', () => {
  it('what a member would save on the same cart, null when nothing', async () => {
    const guest = await priceCart({ lines: [SOFA], isMember: false, evaluate: engine(false, []) });
    const member = await priceCart({ lines: [SOFA], isMember: true, evaluate: engine(true, []) });
    expect(memberSavings(guest, member)).toBe(50_000);
    expect(memberSavings(guest, guest)).toBeNull();
    // Switch off with 20% sitewide: the member pays 4,000 ₪ like the guest → no hint.
    const guest20 = await priceCart({ lines: [SOFA], isMember: false, evaluate: engine(false, [rule()]) });
    const member20 = await priceCart({ lines: [SOFA], isMember: true, evaluate: engine(true, [rule()]) });
    expect(memberSavings(guest20, member20)).toBeNull();
  });
});

describe('line helpers', () => {
  it('regularDiscountLines: every line at its regular price', () => {
    expect(regularDiscountLines([{ ...SOFA, quantity: 3 }])).toEqual([
      { productId: 1, categoryPathIds: [10], lineTotal: 1_500_000, atMemberPrice: false },
    ]);
  });

  it('unpricedLine: a line left out of the totals at its regular price', () => {
    expect(unpricedLine(100_000, 3)).toEqual({ unitPrice: 100_000, atMemberPrice: false, lineTotal: 300_000 });
  });
});
