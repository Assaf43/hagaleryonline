import {
  COUPON_CODE_PATTERN,
  MAX_COUPON_CODE_LENGTH,
  normalizeCouponCode,
  type AdminPromotion,
  type AdminPromotionInput,
  type DiscountType,
  type PromotionKind,
  type PromotionTarget,
  type RelatedPick,
} from '@hg/models';
import { parseShekels, toShekelText } from '../shipping/shipping-form';
import { endFields, israelEndToUtc, israelStartToUtc, startFields } from './israel-time';

/**
 * The promotion form (spec §6, ADM-05): amounts typed in shekels and sent in agorot, a percent as a whole number,
 * dates in Israel time sent in UTC, the coupon code normalized as the API and the customers' entry do. The
 * fields keep the typed text; these pure functions check it and build the API input.
 */

export interface PromotionForm {
  name: string;
  kind: PromotionKind;
  code: string;
  discountType: DiscountType;
  value: string;
  target: PromotionTarget;
  categoryIds: number[];
  products: RelatedPick[];
  minSubtotal: string;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  usageLimit: string;
  active: boolean;
}

/** The form's fields that can show an error, in the order they appear (the first one gets the focus). */
export const FIELD_ORDER = [
  'name',
  'code',
  'value',
  'targetIds',
  'minSubtotal',
  'startDate',
  'startTime',
  'endDate',
  'endTime',
  'usageLimit',
] as const;
export type PromotionField = (typeof FIELD_ORDER)[number];
export type PromotionErrors = Partial<Record<PromotionField, string>>;

/** Element ids of the fields (focus and labels). */
export const FIELD_IDS: Record<PromotionField, string> = {
  name: 'promo-name',
  code: 'promo-code',
  value: 'promo-value',
  targetIds: 'promo-targets',
  minSubtotal: 'promo-min',
  startDate: 'promo-start-date',
  startTime: 'promo-start-time',
  endDate: 'promo-end-date',
  endTime: 'promo-end-time',
  usageLimit: 'promo-limit',
};

export const MESSAGES = {
  name: 'חובה לתת שם למבצע',
  codeRequired: 'חובה למלא קוד קופון',
  codePattern: `אותיות באנגלית או בעברית, ספרות, מקף או קו תחתון, עד ${MAX_COUPON_CODE_LENGTH} תווים`,
  codeTaken: 'כבר יש קופון עם הקוד הזה',
  percent: 'מספר שלם בין 1 ל-100',
  fixed: 'סכום בשקלים, גדול מ-0 (עד שתי ספרות אחרי הנקודה)',
  minSubtotal: 'סכום בשקלים, 0 ומעלה (עד שתי ספרות אחרי הנקודה)',
  categories: 'צריך לבחור לפחות קטגוריה אחת',
  products: 'צריך לבחור לפחות מוצר אחד',
  targetGone: 'אחד הפריטים שנבחרו כבר לא קיים. טענו את המסך מחדש ובחרו שוב.',
  date: 'צריך לבחור תאריך',
  time: 'שעה בפורמט 09:30',
  order: 'הסיום צריך להיות אחרי ההתחלה',
  usageLimit: 'מספר שלם, 1 ומעלה (ריק = ללא הגבלה)',
} as const;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHOLE = /^\d+$/;
const MAX_LIMIT = 1_000_000;

export function emptyForm(): PromotionForm {
  return {
    name: '',
    kind: 'coupon',
    code: '',
    discountType: 'percent',
    value: '',
    target: 'order',
    categoryIds: [],
    products: [],
    minSubtotal: '',
    startDate: '',
    startTime: '',
    endDate: '',
    endTime: '',
    usageLimit: '',
    active: true,
  };
}

export function toForm(p: AdminPromotion): PromotionForm {
  const start = startFields(p.startsAt);
  const end = endFields(p.endsAt);
  return {
    name: p.name,
    kind: p.kind,
    code: p.code ?? '',
    discountType: p.discountType,
    value: p.discountType === 'percent' ? String(p.value) : toShekelText(p.value),
    target: p.target,
    categoryIds: p.target === 'categories' ? p.targets.map((t) => t.id) : [],
    products:
      p.target === 'products'
        ? p.targets.map((t) => ({
            id: t.id,
            modelName: t.modelName ?? '',
            nameHe: t.nameHe,
            active: t.active,
            thumbnailUrl: t.thumbnailUrl,
          }))
        : [],
    minSubtotal: p.minSubtotal ? toShekelText(p.minSubtotal) : '',
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    usageLimit: p.usageLimit === null ? '' : String(p.usageLimit),
    active: p.active,
  };
}

function whole(text: string, min: number, max: number): number | undefined {
  const t = text.trim();
  if (!WHOLE.test(t)) return undefined;
  const n = Number(t);
  return n >= min && n <= max ? n : undefined;
}

/** The API input, or null with the errors by field (in form order). */
export function promotionInput(f: PromotionForm): { input: AdminPromotionInput | null; errors: PromotionErrors } {
  const errors: PromotionErrors = {};
  const coupon = f.kind === 'coupon';

  const name = f.name.trim();
  if (!name) errors.name = MESSAGES.name;

  const code = coupon ? normalizeCouponCode(f.code) : null;
  if (coupon && !code) errors.code = MESSAGES.codeRequired;
  else if (code && (code.length > MAX_COUPON_CODE_LENGTH || !COUPON_CODE_PATTERN.test(code)))
    errors.code = MESSAGES.codePattern;

  let value: number | undefined;
  if (f.discountType === 'percent') {
    value = whole(f.value, 1, 100);
    if (value === undefined) errors.value = MESSAGES.percent;
  } else {
    const agorot = parseShekels(f.value);
    value = agorot ? agorot : undefined;
    if (value === undefined) errors.value = MESSAGES.fixed;
  }

  const targetIds =
    f.target === 'categories' ? f.categoryIds : f.target === 'products' ? f.products.map((p) => p.id) : [];
  if (f.target !== 'order' && targetIds.length === 0)
    errors.targetIds = f.target === 'categories' ? MESSAGES.categories : MESSAGES.products;

  const min = parseShekels(f.minSubtotal);
  if (min === undefined) errors.minSubtotal = MESSAGES.minSubtotal;

  const startsAt = edge(f.startDate, f.startTime, 'startDate', 'startTime', errors, israelStartToUtc);
  const endsAt = edge(f.endDate, f.endTime, 'endDate', 'endTime', errors, israelEndToUtc);
  if (startsAt && endsAt && endsAt <= startsAt && !errors.endDate) errors.endDate = MESSAGES.order;

  let usageLimit: number | null = null;
  if (coupon && f.usageLimit.trim()) {
    const n = whole(f.usageLimit, 1, MAX_LIMIT);
    if (n === undefined) errors.usageLimit = MESSAGES.usageLimit;
    else usageLimit = n;
  }

  const ordered = Object.fromEntries(
    FIELD_ORDER.filter((k) => errors[k]).map((k) => [k, errors[k]]),
  ) as PromotionErrors;
  if (Object.keys(ordered).length) return { input: null, errors: ordered };
  return {
    input: {
      name,
      kind: f.kind,
      code,
      discountType: f.discountType,
      value: value!,
      target: f.target,
      targetIds,
      minSubtotal: min ?? 0,
      startsAt,
      endsAt,
      usageLimit,
      active: f.active,
    },
    errors: {},
  };
}

/** One date (+ optional time) as ISO UTC; null when empty; an error when the time has no date or is malformed. */
function edge(
  date: string,
  time: string,
  dateField: PromotionField,
  timeField: PromotionField,
  errors: PromotionErrors,
  toUtc: (date: string, time: string) => string,
): string | null {
  const d = date.trim();
  const t = time.trim();
  if (t && !TIME.test(t)) errors[timeField] = MESSAGES.time;
  if (!d) {
    if (t) errors[dateField] = MESSAGES.date;
    return null;
  }
  if (!DATE.test(d)) {
    errors[dateField] = MESSAGES.date;
    return null;
  }
  return errors[timeField] ? null : toUtc(d, t);
}

/** The form field a 400/409 of the API names (`field`), or null when it is not one the form shows. */
export function serverFieldOf(apiField: string | undefined): PromotionField | null {
  switch (apiField) {
    case 'startsAt':
      return 'startDate';
    case 'endsAt':
      return 'endDate';
    case 'name':
    case 'code':
    case 'value':
    case 'targetIds':
    case 'minSubtotal':
    case 'usageLimit':
      return apiField;
    default:
      return null;
  }
}
