import { normalizeCouponCode } from '@hg/models';
import {
  couponError,
  couponProblem,
  discountAmount,
  eligibleSubtotal,
  evaluateDiscount,
  promotionEnded,
  type DiscountLine,
  type PromotionRule,
} from './discount-engine.js';

const NOW = new Date('2026-11-11T12:00:00Z');
const DAY = 24 * 60 * 60_000;

let nextId = 1;
function rule(patch: Partial<PromotionRule> = {}): PromotionRule {
  return {
    id: nextId++,
    name: 'מבצע',
    kind: 'automatic',
    code: null,
    discountType: 'percent',
    value: 10,
    target: 'order',
    targetIds: [],
    minSubtotal: 0,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usedCount: 0,
    active: true,
    ...patch,
  };
}
const coupon = (patch: Partial<PromotionRule> = {}) => rule({ kind: 'coupon', code: 'SAVE', name: 'קופון', ...patch });

/** Sofas (10) → corner sofas (11); tables (20). */
const line = (productId: number, categoryPathIds: number[], lineTotal: number): DiscountLine => ({
  productId,
  categoryPathIds,
  lineTotal,
});
const cornerSofa = line(1, [10, 11], 300_000);
const table = line(2, [20], 100_000);
const LINES = [cornerSofa, table];

describe('discount engine (spec §6, CRT-03, decision 70)', () => {
  describe('amounts', () => {
    it('percent on the whole order', () => {
      expect(discountAmount(rule({ value: 10 }), LINES)).toBe(40_000);
    });

    it('percent rounds half up to whole shekels, once per order (never per line)', () => {
      // 10% of 1,995 ₪ = 199.5 ₪ → 200 ₪; 10% of 1,994 ₪ = 199.4 ₪ → 199 ₪.
      expect(discountAmount(rule({ value: 10 }), [line(1, [10], 199_500)])).toBe(20_000);
      expect(discountAmount(rule({ value: 10 }), [line(1, [10], 199_400)])).toBe(19_900);
      // 15% of 10.03 ₪ = 1.5045 ₪ → 2 ₪; 12% of 10.01 ₪ = 1.2012 ₪ → 1 ₪.
      expect(discountAmount(rule({ value: 15 }), [line(1, [10], 1_003)])).toBe(200);
      expect(discountAmount(rule({ value: 12 }), [line(1, [10], 1_001)])).toBe(100);
      // Two lines of 15 ₪ at 10%: 30 ₪ → 3 ₪ (rounding per line would give 2 + 2 = 4 ₪).
      expect(discountAmount(rule({ value: 10 }), [line(1, [10], 1_500), line(2, [10], 1_500)])).toBe(300);
      // Always a multiple of 100 agorot.
      for (const base of [1, 99, 12_345, 987_654])
        expect(discountAmount(rule({ value: 7 }), [line(1, [10], base)]) % 100).toBe(0);
    });

    it('100% never exceeds the eligible subtotal; only that cap can leave agorot', () => {
      expect(discountAmount(rule({ value: 100 }), LINES)).toBe(400_000);
      // 100% of 10.50 ₪ rounds to 11 ₪, capped at 10.50 ₪.
      expect(discountAmount(rule({ value: 100 }), [line(1, [10], 1_050)])).toBe(1_050);
    });

    it('a fixed discount is capped at the eligible subtotal', () => {
      expect(discountAmount(rule({ discountType: 'fixed', value: 50_000 }), LINES)).toBe(50_000);
      expect(discountAmount(rule({ discountType: 'fixed', value: 900_000 }), LINES)).toBe(400_000);
      const onTables = rule({ discountType: 'fixed', value: 150_000, target: 'categories', targetIds: [20] });
      expect(discountAmount(onTables, LINES)).toBe(100_000);
    });

    it('a category target includes its sub-categories', () => {
      const sofas = rule({ target: 'categories', targetIds: [10] });
      expect(eligibleSubtotal(sofas, LINES)).toBe(300_000);
      expect(discountAmount(sofas, LINES)).toBe(30_000);
      const corner = rule({ target: 'categories', targetIds: [11] });
      expect(eligibleSubtotal(corner, LINES)).toBe(300_000);
      const other = rule({ target: 'categories', targetIds: [99] });
      expect(eligibleSubtotal(other, LINES)).toBe(0);
    });

    it('a product target counts only those products', () => {
      const tableOnly = rule({ target: 'products', targetIds: [2] });
      expect(eligibleSubtotal(tableOnly, LINES)).toBe(100_000);
      expect(discountAmount(tableOnly, LINES)).toBe(10_000);
    });
  });

  describe('eligibility', () => {
    it('the minimum is on the eligible subtotal, not the whole cart', () => {
      const tables = rule({ target: 'categories', targetIds: [20], minSubtotal: 150_000 });
      // The cart is 400,000 but the tables only 100,000.
      expect(evaluateDiscount(LINES, [tables], null, NOW).applied).toBeNull();
      const ok = rule({ target: 'categories', targetIds: [20], minSubtotal: 100_000 });
      expect(evaluateDiscount(LINES, [ok], null, NOW).applied?.amount).toBe(10_000);
    });

    it('dates: not before the start, not after the end', () => {
      const future = rule({ startsAt: new Date(NOW.getTime() + DAY) });
      const past = rule({ endsAt: new Date(NOW.getTime() - 1) });
      const running = rule({ startsAt: new Date(NOW.getTime() - DAY), endsAt: new Date(NOW.getTime() + DAY) });
      expect(evaluateDiscount(LINES, [future], null, NOW).applied).toBeNull();
      expect(evaluateDiscount(LINES, [past], null, NOW).applied).toBeNull();
      expect(evaluateDiscount(LINES, [running], null, NOW).applied?.amount).toBe(40_000);
      // The boundaries themselves are inside.
      expect(evaluateDiscount(LINES, [rule({ startsAt: NOW, endsAt: NOW })], null, NOW).applied?.amount).toBe(40_000);
    });

    it('an inactive promotion never applies', () => {
      expect(evaluateDiscount(LINES, [rule({ active: false })], null, NOW).applied).toBeNull();
    });

    it('a promotion whose amount rounds to 0 does not apply', () => {
      // 1% of 0.40 ₪ → 0 ₪.
      const tiny = [line(1, [10], 40)];
      expect(evaluateDiscount(tiny, [rule({ value: 1 })], null, NOW).applied).toBeNull();
      const result = evaluateDiscount(tiny, [], coupon({ value: 1 }), NOW);
      expect(result).toMatchObject({ applied: null, couponOutcome: 'invalid', couponProblem: 'not_applicable' });
      expect(couponError(coupon({ value: 1 }), 40, NOW)).toBe('הקופון לא חל על המוצרים בסל');
    });

    it('no lines → no discount', () => {
      expect(evaluateDiscount([], [rule()], null, NOW)).toEqual({
        applied: null,
        promotion: null,
        couponOutcome: 'none',
        couponProblem: null,
      });
    });
  });

  describe('one discount per order', () => {
    it('the largest automatic promotion wins', () => {
      const small = rule({ name: 'קטן', value: 5 });
      const big = rule({ name: 'גדול', discountType: 'fixed', value: 60_000 });
      const result = evaluateDiscount(LINES, [small, big], null, NOW);
      expect(result.applied).toEqual({ labelHe: 'גדול', amount: 60_000, source: 'automatic', code: null });
      expect(result.promotion?.id).toBe(big.id);
      expect(result.couponOutcome).toBe('none');
    });

    it('a better coupon beats the automatic promotion', () => {
      const auto = rule({ value: 5 });
      const code = coupon({ value: 20 });
      const result = evaluateDiscount(LINES, [auto], code, NOW);
      expect(result.applied).toEqual({ labelHe: 'קופון', amount: 80_000, source: 'coupon', code: 'SAVE' });
      expect(result.promotion?.id).toBe(code.id);
      expect(result.couponOutcome).toBe('applied');
      expect(result.couponProblem).toBeNull();
    });

    it('a tie goes to the automatic promotion', () => {
      const auto = rule({ value: 10 });
      const code = coupon({ discountType: 'fixed', value: 40_000 });
      const result = evaluateDiscount(LINES, [auto], code, NOW);
      expect(result.applied?.source).toBe('automatic');
      expect(result.couponOutcome).toBe('lost_to_automatic');
    });

    it('a coupon that loses → lost_to_automatic, the automatic one applies', () => {
      const auto = rule({ value: 25 });
      const result = evaluateDiscount(LINES, [auto], coupon({ value: 10 }), NOW);
      expect(result.applied).toMatchObject({ amount: 100_000, source: 'automatic' });
      expect(result.couponOutcome).toBe('lost_to_automatic');
      expect(result.couponProblem).toBe('lost');
    });

    it('a coupon whose usage limit is reached is invalid', () => {
      const used = coupon({ usageLimit: 3, usedCount: 3 });
      const result = evaluateDiscount(LINES, [], used, NOW);
      expect(result.applied).toBeNull();
      expect(result.couponOutcome).toBe('invalid');
      expect(result.couponProblem).toBe('exhausted');
      expect(evaluateDiscount(LINES, [], coupon({ usageLimit: 3, usedCount: 2 }), NOW).couponOutcome).toBe('applied');
    });

    it('an invalid coupon leaves the automatic promotion in place', () => {
      const auto = rule({ value: 5 });
      const result = evaluateDiscount(LINES, [auto], coupon({ active: false }), NOW);
      expect(result.applied?.source).toBe('automatic');
      expect(result.couponOutcome).toBe('invalid');
      expect(result.couponProblem).toBe('expired');
    });

    it('automatic promotions in the list that are coupons are ignored', () => {
      expect(evaluateDiscount(LINES, [coupon()], null, NOW).applied).toBeNull();
    });
  });

  describe('promotionEnded (retry of an order with a promotion)', () => {
    it('inactive, out of dates or used up', () => {
      expect(promotionEnded(coupon(), NOW)).toBe(false);
      expect(promotionEnded(coupon({ active: false }), NOW)).toBe(true);
      expect(promotionEnded(coupon({ endsAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(true);
      expect(promotionEnded(coupon({ startsAt: new Date(NOW.getTime() + DAY) }), NOW)).toBe(true);
      expect(promotionEnded(coupon({ usageLimit: 2, usedCount: 2 }), NOW)).toBe(true);
      expect(promotionEnded(coupon({ usageLimit: 2, usedCount: 1 }), NOW)).toBe(false);
    });
  });

  describe('normalizeCouponCode (@hg/models)', () => {
    it('NFKC, bidi and zero-width marks removed, trimmed, upper-case', () => {
      expect(normalizeCouponCode(' \u200Fsave10\u200E ')).toBe('SAVE10');
      expect(normalizeCouponCode('\u202Bwin\u200Bter\u202C\uFEFF')).toBe('WINTER');
      expect(normalizeCouponCode('\u2066\uFF33\uFF21\uFF2C\uFF25\uFF12\uFF10\u2069')).toBe('SALE20');
    });
  });

  describe('coupon errors', () => {
    it('unknown, expired, inactive, not started, exhausted, below minimum, not applicable', () => {
      expect(couponError(null, 400_000, NOW)).toBe('קוד הקופון לא קיים');
      expect(couponError(rule(), 400_000, NOW)).toBe('קוד הקופון לא קיים');
      expect(couponError(coupon({ endsAt: new Date(NOW.getTime() - 1) }), 400_000, NOW)).toBe('תוקף הקופון פג');
      expect(couponError(coupon({ active: false }), 400_000, NOW)).toBe('תוקף הקופון פג');
      // Not started yet has its own message (owner ruling R21).
      expect(couponError(coupon({ startsAt: new Date(NOW.getTime() + DAY) }), 400_000, NOW)).toBe(
        'הקופון עוד לא בתוקף',
      );
      expect(couponError(coupon({ usageLimit: 1, usedCount: 1 }), 400_000, NOW)).toBe('הקופון נוצל במלואו');
      expect(couponError(coupon({ minSubtotal: 500_000 }), 400_000, NOW)).toBe('הקופון תקף מסכום של 5,000 ₪');
      expect(couponError(coupon({ minSubtotal: 123_456 }), 0, NOW)).toBe('הקופון לא חל על המוצרים בסל');
      expect(couponError(coupon({ minSubtotal: 400_000 }), 400_000, NOW)).toBeNull();
      expect(couponProblem(coupon(), 10_000, NOW)).toBeNull();
    });
  });
});
