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
export type CouponProblem =
  'unknown' | 'not_started' | 'expired' | 'below_minimum' | 'exhausted' | 'not_applicable' | 'lost';

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
  /** Before its start date (owner ruling R21); a deactivated coupon or one past its end is expired. */
  not_started: 'הקופון עוד לא בתוקף',
  expired: 'תוקף הקופון פג',
  exhausted: 'הקופון נוצל במלואו',
  not_applicable: 'הקופון לא חל על המוצרים בסל',
  lost: 'המבצע הנוכחי משתלם יותר מהקופון',
};

/** "הקופון תקף מסכום של {price}"; `price` is the formatted minimum, e.g. "1,000 ₪". */
export function couponMinimumMessageHe(price: string): string {
  return `הקופון תקף מסכום של ${price}`;
}

// ---------- Admin "מבצעים וקופונים" (Phase 4d, ADM-05, permission promotions.manage) ----------

/** Longest coupon code (characters, after `normalizeCouponCode`). */
export const MAX_COUPON_CODE_LENGTH = 64;

/**
 * Characters a coupon code may have once normalized: Latin capitals, Hebrew letters, digits, "-" and "_". These have
 * one upper-case form in JavaScript and PostgreSQL alike (the DB checks `code = upper(code)`).
 */
export const COUPON_CODE_PATTERN = /^[A-Z0-9א-ת_-]+$/;

/** Hebrew labels of the admin screen. */
export const PROMOTION_KIND_LABELS_HE: Record<PromotionKind, string> = {
  automatic: 'מבצע אוטומטי',
  coupon: 'קופון',
};
export const DISCOUNT_TYPE_LABELS_HE: Record<DiscountType, string> = {
  percent: 'אחוז הנחה',
  fixed: 'סכום קבוע',
};
export const PROMOTION_TARGET_LABELS_HE: Record<PromotionTarget, string> = {
  order: 'כל ההזמנה',
  categories: 'קטגוריות',
  products: 'מוצרים',
};

/** A category or product the promotion targets, with what the admin shows of it. */
export interface PromotionTargetRef {
  id: number;
  nameHe: string;
  /** Products only (English model name); null for a category. */
  modelName: string | null;
  /** Products only: shown on the site; categories: always true. */
  active: boolean;
  /** Products only: first photo; null otherwise. */
  thumbnailUrl: string | null;
}

/** One promotion in the admin (GET /api/admin/promotions, GET/PUT /api/admin/promotions/:id). Money in agorot. */
export interface AdminPromotion {
  id: number;
  name: string;
  kind: PromotionKind;
  /** Coupons only (normalized, upper-case). */
  code: string | null;
  discountType: DiscountType;
  /** Percent 1–100, or agorot for a fixed discount. */
  value: number;
  target: PromotionTarget;
  /** In the saved order; empty for the whole order. */
  targets: PromotionTargetRef[];
  minSubtotal: number;
  /** ISO times (UTC); null = no start / no end. */
  startsAt: string | null;
  endsAt: string | null;
  /** Coupons only; null = no limit. */
  usageLimit: number | null;
  /** Paid orders that used it. */
  usedCount: number;
  active: boolean;
  /** "הטבת הצטרפות" (decision 79): automatic only; the first paid order of each account. */
  isWelcome: boolean;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/promotions and PUT /api/admin/promotions/:id. */
export interface AdminPromotionInput {
  name: string;
  kind: PromotionKind;
  code: string | null;
  discountType: DiscountType;
  value: number;
  target: PromotionTarget;
  targetIds: number[];
  minSubtotal: number;
  startsAt: string | null;
  endsAt: string | null;
  usageLimit: number | null;
  active: boolean;
  /**
   * The welcome benefit (decision 79): automatic promotions only (400 `isWelcome` otherwise). Saving it `true` clears
   * it on every other promotion (each change audited). Missing: false on create, unchanged on edit.
   */
  isWelcome?: boolean;
}

/** GET /api/admin/promotions/categories: every category in tree order, for the category picker. */
export interface PromotionCategoryOption {
  id: number;
  nameHe: string;
  /** 0 for a top-level category. */
  depth: number;
}
