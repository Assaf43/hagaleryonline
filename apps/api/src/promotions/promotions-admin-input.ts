import {
  COUPON_CODE_PATTERN,
  MAX_COUPON_CODE_LENGTH,
  normalizeCouponCode,
  type AdminPromotionInput,
  type DiscountType,
  type PromotionKind,
  type PromotionTarget,
} from '@hg/models';
import { invalid } from '../catalog-admin/catalog-errors.js';
import { MAX_AMOUNT } from '../shipping/shipping-admin-input.js';

const MAX_NAME = 100;
const MAX_TARGETS = 1_000;
const MAX_USAGE_LIMIT = 1_000_000;
const KINDS: readonly PromotionKind[] = ['automatic', 'coupon'];
const TYPES: readonly DiscountType[] = ['percent', 'fixed'];
const TARGETS: readonly PromotionTarget[] = ['order', 'categories', 'products'];
/** An ISO time with a zone ("2026-12-01T22:00:00.000Z"); the admin converts Israel time to UTC before sending. */
const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const MIN_YEAR = 2000;
const MAX_YEAR = 2100;
/** Fixed amounts and minimums are whole shekels (agorot divisible by 100). */
const SHEKEL = 100;

type Body = Record<string, unknown>;

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

function oneOf<T extends string>(value: unknown, list: readonly T[], field: string): T {
  if (typeof value !== 'string' || !list.includes(value as T)) throw invalid(field);
  return value as T;
}

/**
 * A real calendar time between 2000 and 2100: the written date and time must exist as written (no 31.2, no 24:00,
 * no year 0000) — `Date` would roll them over silently.
 */
function time(value: unknown, field: string): Date | null {
  if (value === null || value === undefined) return null;
  const match = typeof value === 'string' ? ISO.exec(value) : null;
  if (!match) throw invalid(field);
  const [y, mo, d, h, mi, s] = match.slice(1).map((part) => Number(part ?? 0));
  const written = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (
    y < MIN_YEAR ||
    y > MAX_YEAR ||
    written.getUTCFullYear() !== y ||
    written.getUTCMonth() !== mo - 1 ||
    written.getUTCDate() !== d ||
    written.getUTCHours() !== h ||
    written.getUTCMinutes() !== mi ||
    written.getUTCSeconds() !== s
  )
    throw invalid(field);
  const date = new Date(value as string);
  if (Number.isNaN(date.getTime())) throw invalid(field);
  return date;
}

/**
 * POST/PUT /api/admin/promotions (spec §6). Everything the database CHECKs (code upper-case, code iff coupon,
 * value > 0, percent ≤ 100) is refused here first as a 400 with the field, so the DB never has to. Fixed amounts and
 * the minimum are whole shekels; dates are real times between 2000 and 2100. Also: a usage
 * limit only on coupons, dates in order, targets by kind (none for the whole order, distinct ids otherwise; whether
 * they exist is checked by the service). The code is normalized like a customer's entry.
 */
export function parsePromotionInput(body: unknown): AdminPromotionInput {
  const b = (body ?? {}) as Body;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > MAX_NAME) throw invalid('name');
  const kind = oneOf(b.kind, KINDS, 'kind');

  let code: string | null = null;
  if (kind === 'coupon') {
    code = typeof b.code === 'string' ? normalizeCouponCode(b.code) : '';
    if (!code || code.length > MAX_COUPON_CODE_LENGTH || !COUPON_CODE_PATTERN.test(code)) throw invalid('code');
  } else if (b.code !== null && b.code !== undefined && b.code !== '') {
    throw invalid('code');
  }

  const discountType = oneOf(b.discountType, TYPES, 'discountType');
  const value = b.value;
  if (!isInt(value, 1, discountType === 'percent' ? 100 : MAX_AMOUNT)) throw invalid('value');
  if (discountType === 'fixed' && value % SHEKEL !== 0) throw invalid('value');

  const target = oneOf(b.target, TARGETS, 'target');
  const ids = b.targetIds;
  if (
    !Array.isArray(ids) ||
    ids.length > MAX_TARGETS ||
    !ids.every((id) => isInt(id, 1, 2 ** 31 - 1)) ||
    new Set(ids).size !== ids.length ||
    (target === 'order') !== (ids.length === 0)
  )
    throw invalid('targetIds');

  const minSubtotal = b.minSubtotal;
  if (!isInt(minSubtotal, 0, MAX_AMOUNT) || minSubtotal % SHEKEL !== 0) throw invalid('minSubtotal');

  const startsAt = time(b.startsAt, 'startsAt');
  const endsAt = time(b.endsAt, 'endsAt');
  if (startsAt && endsAt && endsAt <= startsAt) throw invalid('endsAt');

  let usageLimit: number | null = null;
  if (b.usageLimit !== null && b.usageLimit !== undefined) {
    // Automatic promotions have no limit (spec §6: "usage limit (coupon only)").
    if (kind !== 'coupon' || !isInt(b.usageLimit, 1, MAX_USAGE_LIMIT)) throw invalid('usageLimit');
    usageLimit = b.usageLimit;
  }

  if (typeof b.active !== 'boolean') throw invalid('active');

  // The welcome benefit (decision 79) is applied automatically: never a coupon.
  const isWelcome = b.isWelcome ?? false;
  if (typeof isWelcome !== 'boolean' || (isWelcome && kind !== 'automatic')) throw invalid('isWelcome');

  return {
    name,
    kind,
    code,
    discountType,
    value,
    target,
    targetIds: ids as number[],
    minSubtotal,
    startsAt: startsAt?.toISOString() ?? null,
    endsAt: endsAt?.toISOString() ?? null,
    usageLimit,
    active: b.active,
    isWelcome,
  };
}
