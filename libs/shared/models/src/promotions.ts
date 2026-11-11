/**
 * Promotions and coupons (Phase 4d, spec §6, CRT-03, ADM-05, decision 70). One discount per order: the best
 * automatic promotion or the entered coupon, whichever is larger (ties go to the automatic one). Money in agorot.
 */

export type PromotionKind = 'automatic' | 'coupon';
export type DiscountType = 'percent' | 'fixed';
export type PromotionTarget = 'order' | 'categories' | 'products';

/** POST /api/cart/coupon — the code is matched case-insensitively and stored upper-case. */
export interface ApplyCouponRequest {
  code: string;
}

/** Bidi and zero-width marks a pasted code may carry (U+200B–U+200F, U+202A–U+202E, U+2066–U+2069, U+FEFF). */
const INVISIBLE_MARKS = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;

/**
 * The one form of a coupon code, used by the API (customer entry, admin save) and the admin form: NFKC, bidi and
 * zero-width marks removed, trimmed, upper-case. Codes are unique and compared in this form.
 */
export function normalizeCouponCode(code: string): string {
  return code.normalize('NFKC').replace(INVISIBLE_MARKS, '').trim().toUpperCase();
}

/** Why an entered coupon gives no discount. */
export type CouponProblem = 'unknown' | 'expired' | 'below_minimum' | 'exhausted' | 'not_applicable' | 'lost';

/** Hebrew of the retry-payment 409 `promotion_ended`: the order's promotion or coupon is no longer valid. */
export const PROMOTION_ENDED_MESSAGE_HE = 'המבצע או הקופון של ההזמנה כבר לא בתוקף. חזרו לסל כדי להזמין מחדש.';

/**
 * 400 of POST /api/cart/coupon (`code: 'invalid_coupon'`), and 409 of POST /api/checkout
 * (`code: 'coupon_invalid'`, `field: 'coupon'`) when the coupon was used up in the meantime.
 */
export interface CouponErrorBody {
  statusCode: 400 | 409;
  code: 'invalid_coupon' | 'coupon_invalid';
  field: 'coupon';
  messageHe: string;
}

/** Hebrew messages of the coupon problems; `below_minimum` is built with `couponMinimumMessageHe`. */
export const COUPON_MESSAGES_HE: Record<Exclude<CouponProblem, 'below_minimum'>, string> = {
  unknown: 'קוד הקופון לא קיים',
  expired: 'תוקף הקופון פג',
  exhausted: 'הקופון נוצל במלואו',
  not_applicable: 'הקופון לא חל על המוצרים בסל',
  lost: 'המבצע הנוכחי משתלם יותר מהקופון',
};

/** "הקופון תקף מסכום של {price}"; `price` is the formatted minimum, e.g. "1,000 ₪". */
export function couponMinimumMessageHe(price: string): string {
  return `הקופון תקף מסכום של ${price}`;
}
