import { HttpErrorResponse } from '@angular/common/http';
import type {
  ActivationProblem,
  AuthErrorCode,
  CatalogErrorCode,
  ImageUploadProblem,
  ShippingAdminErrorCode,
} from '@hg/models';

const MESSAGES: Record<AuthErrorCode, string> = {
  invalid_credentials: 'האימייל או הסיסמה שגויים.',
  too_many_attempts: 'יותר מדי ניסיונות.',
  invalid_code: 'הקוד שגוי. בדקו שהשעה בטלפון מדויקת ונסו שוב.',
  weak_password: 'הסיסמה לא מספיק חזקה.',
  invalid_link: 'הקישור כבר לא בתוקף. בקשו קישור חדש מה-Super Admin.',
  not_authenticated: 'צריך להתחבר מחדש.',
  mfa_required: 'צריך להשלים את האימות הדו-שלבי.',
  forbidden: 'אין לכם הרשאה לפעולה הזו.',
  email_taken: 'כבר יש משתמש עם האימייל הזה.',
};

const WEAK_PASSWORD: Record<string, string> = {
  too_short: 'הסיסמה צריכה להיות באורך 12 תווים לפחות.',
  too_long: 'הסיסמה ארוכה מדי (עד 128 תווים).',
  too_common: 'הסיסמה קלה מדי לניחוש. נסו משפט של כמה מילים שרק אתם מכירים.',
  too_personal: 'הסיסמה לא יכולה לכלול את השם או האימייל שלכם.',
};

/** Field names the catalog API reports, in Hebrew. Variant fields arrive as "variants.<row>.<field>". */
const FIELDS: Record<string, string> = {
  slug: 'כתובת באתר',
  modelName: 'שם דגם',
  nameHe: 'שם',
  descriptionHe: 'תיאור',
  categoryId: 'קטגוריה',
  roomIds: 'חדרים',
  attributes: 'מאפיינים',
  warrantyMonths: 'אחריות',
  sortOrder: 'סדר',
  'relations.goesWith': 'הולך מושלם עם',
  'relations.similar': 'מוצרים דומים',
  parentId: 'קטגוריית אב',
  attributeCodes: 'מסננים',
  code: 'קוד באנגלית',
  labelHe: 'שם בעברית',
  swatchHex: 'צבע לדוגמית',
  scope: 'רמת המאפיין',
  terms: 'מילים',
  value: 'ערך',
  sku: 'מק"ט',
  price: 'מחיר',
  compareAtPrice: 'מחיר לפני הנחה',
  memberPrice: 'מחיר מועדון',
  stock: 'מלאי',
  fulfillment: 'מצב אספקה',
  leadTimeDays: 'זמן אספקה',
  productionDays: 'ימי ייצור',
  expectedAt: 'תאריך הגעה',
  options: 'אפשרויות',
  widthCm: 'רוחב',
  depthCm: 'עומק',
  heightCm: 'גובה',
  weightKg: 'משקל',
  seatHeightCm: 'גובה מושב',
  seatDepthCm: 'עומק מושב',
  chaiseWidthCm: 'רוחב שזלונג',
  chaiseDepthCm: 'עומק שזלונג',
  colorCode: 'צבע',
  kind: 'סוג תמונה',
  altHe: 'תיאור התמונה',
  ids: 'סדר התמונות',
  rates: 'מחירון המשלוחים',
  deliveryPrice: 'מחיר הובלה',
  assemblyPrice: 'מחיר הרכבה',
  additionalItemPercent: 'אחוז לכל פריט נוסף',
  floorSurcharge: 'תוספת לכל קומה',
  floorSurchargeFrom: 'החל מקומה',
  name: 'שם',
  surcharge: 'תוספת',
  localityIds: 'יישובים',
};

/** Why a photo upload was refused (Phase 2d). */
export const IMAGE_PROBLEMS: Record<ImageUploadProblem, string> = {
  type: 'אפשר להעלות רק תמונות JPG, PNG או WebP.',
  too_large: 'התמונה גדולה מדי. עד 15MB לתמונה.',
  too_small: 'התמונה קטנה מדי. צריך לפחות 600 פיקסלים בצד הארוך.',
  too_many: 'הגעתם למספר התמונות המרבי למוצר (40).',
  unreadable: 'לא הצלחנו לקרוא את הקובץ. ייתכן שהוא פגום.',
};

const ACTIVATION: Record<ActivationProblem, string> = {
  no_variants: 'צריך לפחות וריאנט פעיל אחד',
  no_images: 'צריך לפחות תמונה אחת',
  category_hidden: 'הקטגוריה מוסתרת',
};

/** "variants.3.price" → "מחיר בשורה 4" (also "rates.<row>.<field>"); "slug" → "כתובת באתר". */
export function fieldLabel(field: string): string {
  const variant = /^(?:variants|rates)\.(\d+)\.(\w+)$/.exec(field);
  if (variant) return `${FIELDS[variant[2]] ?? variant[2]} בשורה ${Number(variant[1]) + 1}`;
  return FIELDS[field] ?? field;
}

function catalogMessage(body: {
  code?: CatalogErrorCode;
  field?: string;
  value?: string;
  reasons?: ActivationProblem[];
  messageHe?: string;
}): string | null {
  switch (body.code) {
    case 'conflict':
      return 'מישהו אחר שמר את המוצר בזמן שעבדתם עליו. טענו אותו מחדש כדי לראות את השינויים, ואז ערכו שוב.';
    case 'duplicate':
      return `${fieldLabel(body.field ?? '')}${body.value ? ` "${body.value}"` : ''} כבר קיים. בחרו ערך אחר.`;
    case 'invalid':
      if (body.field === 'file' && body.value && body.value in IMAGE_PROBLEMS)
        return IMAGE_PROBLEMS[body.value as ImageUploadProblem];
      return `יש לבדוק את השדה: ${fieldLabel(body.field ?? '')}.`;
    case 'member_price_not_lower':
      return `${fieldLabel(body.field ?? '')} חייב להיות נמוך מהמחיר.`;
    case 'in_use':
      // The API names the reason itself when it is not the usual one (a product that was ordered).
      return body.messageHe ?? 'אי אפשר למחוק, כי יש מוצרים או תמונות שמשתמשים בזה.';
    case 'incomplete':
      return `אי אפשר להציג את המוצר באתר עדיין: ${(body.reasons ?? []).map((r) => ACTIVATION[r]).join(', ')}.`;
    case 'not_found':
      return 'הפריט לא נמצא. ייתכן שנמחק.';
    default:
      return null;
  }
}

/** Field names of the content API (Phase 8a), in Hebrew. */
const CONTENT_FIELDS: Record<string, string> = {
  textHe: 'טקסט ההודעה',
  linkUrl: 'קישור',
  linkLabelHe: 'טקסט הקישור',
  startsAt: 'תאריך התחלה',
  endsAt: 'תאריך סיום',
  sortOrder: 'סדר',
  slug: 'כתובת באתר',
  titleHe: 'כותרת',
  bodyHtml: 'תוכן העמוד',
  metaDescriptionHe: 'תיאור לגוגל',
  footerLabelHe: 'שם בכותרת התחתונה',
  footerOrder: 'סדר בכותרת התחתונה',
  supportPhone: 'טלפון',
  supportEmail: 'דוא"ל',
  whatsapp: 'וואטסאפ',
  shippingHtml: 'טקסט המשלוח',
  items: 'שאלות ותשובות',
  expectedUpdatedAt: 'גרסת העמוד',
  endedLinkUrl: 'קישור אחרי הסיום',
};

/** Banner and home page fields (Phase 8b); only read on content screens, where `nameHe` etc. mean something else. */
const BANNER_FIELDS: Record<string, string> = {
  nameHe: 'שם פנימי',
  headlineHe: 'כותרת',
  sublineHe: 'שורת משנה',
  ctaLabelHe: 'טקסט הכפתור',
  imageId: 'תמונה',
  mobileImageId: 'תמונה לנייד',
  altHe: 'טקסט חלופי לתמונה',
  introHtml: 'טקסט פתיחה',
  outroHtml: 'טקסט סיום',
  source: 'מקור המוצרים',
  'source.id': 'מקור המוצרים',
  'source.productIds': 'מוצרים שנבחרו',
  status: 'סטטוס',
};

/** Why a content photo upload was refused (Phase 8b): at least 1200 px on the long side. */
export const CONTENT_IMAGE_PROBLEMS: Partial<Record<ImageUploadProblem, string>> = {
  type: IMAGE_PROBLEMS.type,
  too_large: IMAGE_PROBLEMS.too_large,
  too_small: 'התמונה קטנה מדי. צריך לפחות 1200 פיקסלים בצד הארוך.',
  unreadable: IMAGE_PROBLEMS.unreadable,
};

function contentFieldLabel(field: string): string {
  const item = /^items\.(\d+)\.(\w+)$/.exec(field);
  if (item) {
    const n = Number(item[1]) + 1;
    return item[2] === 'answerHtml' ? `תשובה ${n}` : `שאלה ${n}`;
  }
  return Object.hasOwn(CONTENT_FIELDS, field) ? CONTENT_FIELDS[field] : 'שדה';
}

/**
 * Content errors (Phase 8a): `invalid_link` here always names a field (the auth code of the same name has none),
 * `invalid` only when the field is a content one, `slug_taken` and `system_page`.
 */
function contentMessage(
  body: { code?: string; field?: string; value?: string; sections?: string[] },
  url?: string | null,
): string | null {
  const field = body.field ?? '';
  const onContent = !!url?.includes('/api/admin/content/');
  switch (body.code) {
    case 'banner_in_use': {
      const names = (body.sections ?? []).map((n) => `"${n}"`).join(', ');
      return `אי אפשר למחוק את הבאנר כי הוא בשימוש בדף הבית${names ? `: ${names}` : ''}. הסירו אותו משם ושמרו, ואז מחקו.`;
    }
    case 'invalid_source':
      return 'המבצע שנבחר לא מתאים. צריך מבצע אוטומטי על קטגוריות או מוצרים, שלא חל על כל ההזמנה ולא לחברי מועדון בלבד.';
    case 'conflict':
      // The catalog wording talks about a product; the same code on a content screen gets its own.
      return url?.includes('/api/admin/content/')
        ? 'מישהו אחר שמר את הדף הזה בינתיים. טענו מחדש כדי לראות את הגרסה החדשה.'
        : null;
    case 'invalid_link':
      if (!field) return null;
      return `הקישור בשדה "${contentFieldLabel(field)}" לא תקין. אפשר https://, mailto:, tel: או כתובת באתר שמתחילה ב-/.`;
    case 'slug_taken':
      return 'כבר יש עמוד עם הכתובת הזו. בחרו כתובת אחרת.';
    case 'system_page':
      if (field === 'slug') return 'עמוד מערכת: אי אפשר לשנות את הכתובת.';
      if (field === 'published') return 'עמוד מערכת: תמיד מפורסם.';
      return 'עמוד מערכת: אי אפשר למחוק אותו.';
    case 'invalid':
      if (onContent && field === 'file') {
        const reason = body.value ? CONTENT_IMAGE_PROBLEMS[body.value as ImageUploadProblem] : undefined;
        if (reason) return reason;
      }
      if (onContent && Object.hasOwn(BANNER_FIELDS, field)) return `יש לבדוק את השדה: ${BANNER_FIELDS[field]}.`;
      if (onContent && /^sections\.\d+\./.test(field)) {
        return `יש לבדוק את מקום ${Number(field.split('.')[1]) + 1} בדף הבית.`;
      }
      if (field === 'linkLabelHe') return 'יש להוסיף קישור לטקסט הקישור, או למחוק את טקסט הקישור.';
      if (Object.hasOwn(CONTENT_FIELDS, field) || /^items\.\d+\./.test(field)) {
        return `יש לבדוק את השדה: ${contentFieldLabel(field)}.`;
      }
      return null;
    default:
      return null;
  }
}

/** 409 of the shipping zones: a locality is in one zone only (spec §4.1). */
function shippingMessage(body: { code?: ShippingAdminErrorCode; localityNameHe?: string; zoneName?: string }) {
  if (body.code !== 'locality_taken') return null;
  return body.localityNameHe && body.zoneName
    ? `היישוב ${body.localityNameHe} כבר שייך לאזור "${body.zoneName}". הסירו אותו משם קודם.`
    : 'אחד היישובים כבר שייך לאזור אחר. טענו את המסך מחדש ונסו שוב.';
}

/** Why a row of an Excel import was refused by the product checks (short, for the issues table). */
export function catalogIssueText(code: CatalogErrorCode): string {
  const text: Record<CatalogErrorCode, string> = {
    invalid: 'הערך לא תקין (למשל מחיר לפני הנחה שלא גבוה מהמחיר)',
    member_price_not_lower: 'מחיר המועדון חייב להיות נמוך מהמחיר',
    duplicate: 'הערך כבר קיים במוצר אחר',
    conflict: 'המוצר השתנה בזמן הייבוא. נסו שוב',
    in_use: 'בשימוש',
    incomplete: 'חסר מידע כדי להציג את המוצר',
    not_found: 'לא נמצא',
  };
  return text[code];
}

/** 400 `rate` of the VAT setting; the VAT page shows it for a bad percent before sending. */
export const VAT_RATE_MESSAGE = 'שיעור המע"מ חייב להיות גדול מ־0% וקטן מ־100%, עד 2 ספרות אחרי הנקודה.';

/** 400 `returnWindowDays` of the store settings; the page shows it for a bad number before sending. */
export const RETURN_WINDOW_MESSAGE = 'מספר ימי ההחזרה צריך להיות מספר שלם בין 1 ל־60.';

/** 400 on the store details: `nameHe`, and the other fields; the store page shows them before sending. */
export const STORE_NAME_MESSAGE = 'שם החנות הוא שדה חובה (עד 80 תווים).';
export const STORE_TEXT_MESSAGE = 'כתובת, שעות וטלפון: עד 200 תווים בכל שדה.';

/** 400 `body` of a ticket note; the ticket page shows it for an empty note before sending. */
export const NOTE_MESSAGE = 'יש לכתוב הערה (עד 2000 תווים).';

/** Order actions (Phase 5): 409 codes, and the field a 400 `invalid_input` names. */
const ORDER_CODES: Record<string, string> = {
  invalid_transition: 'אי אפשר לעבור לסטטוס הזה',
  refund_exceeds_paid: 'הסכום גדול מהיתרה להחזר',
  vat_rate_exists: 'כבר יש שיעור מע"מ שמתחיל בתאריך הזה.',
  // "משימות שנכשלו": the job was already retried (another tab or user).
  not_failed: 'המשימה כבר לא במצב "נכשלה". רעננו את הדף.',
  // "הנפקת קופון אישי" (Phase 7c): the customer has no verified e-mail to send the code to.
  email_not_verified: 'אין ללקוח מייל מאומת, אי אפשר לשלוח את הקוד במייל.',
};

const ORDER_FIELDS: Record<string, string> = {
  'slot.date': 'תאריך האספקה לא תקין (לא יכול להיות לפני היום).',
  'slot.window': 'טווח השעות לא תקין. שעת ההתחלה צריכה להיות לפני שעת הסיום.',
  reason: 'יש למלא סיבה (3–500 תווים).',
  amount: 'הסכום לא תקין.',
  month: 'החודש לא תקין.',
  rate: VAT_RATE_MESSAGE,
  effectiveFrom: 'התאריך חייב להיות אחרי היום ואחרי תאריך ההתחלה של כל שיעור קיים.',
  refund: 'בחירת ההחזר לא תקינה להזמנה הזו.',
  // Support inbox (Phase 5d).
  body: NOTE_MESSAGE,
  status: 'הסטטוס לא תקין.',
  returnWindowDays: RETURN_WINDOW_MESSAGE,
};

/**
 * 400 `invalid_input` fields of the store details page only (Phase 6): a bare `phone` or `address` means something
 * else on other screens, so they are not in `ORDER_FIELDS`.
 */
const STORE_SETTINGS_FIELDS: Record<string, string> = {
  nameHe: STORE_NAME_MESSAGE,
  address: STORE_TEXT_MESSAGE,
  hoursHe: STORE_TEXT_MESSAGE,
  phone: STORE_TEXT_MESSAGE,
};

/** The store details page's error text: its own field messages, then the general ones. */
export function storeSettingsErrorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const body = (error.error ?? {}) as { code?: string; field?: string };
    if (body.code === 'invalid_input' && body.field && STORE_SETTINGS_FIELDS[body.field]) {
      return STORE_SETTINGS_FIELDS[body.field];
    }
  }
  return errorMessage(error);
}

/** 400 `invalid` of the promotions API on a field the form has no input of its own for. */
const PROMOTION_FIELDS: Record<string, string> = {
  isWelcome: 'הטבת הצטרפות אפשרית רק בתבנית לקוד אישי.',
  validityDays: 'ימי התוקף צריכים להיות מספר שלם בין 1 ל-365.',
  templateId: 'התבנית כבר לא פעילה. סגרו את החלון ובחרו תבנית אחרת.',
};

function promotionMessage(body: { code?: string; field?: string }): string | null {
  return body.code === 'invalid' && body.field ? (PROMOTION_FIELDS[body.field] ?? null) : null;
}

function orderMessage(body: { code?: string; field?: string }): string | null {
  if (body.code && ORDER_CODES[body.code]) return ORDER_CODES[body.code];
  if (body.code === 'invalid_input' && body.field && ORDER_FIELDS[body.field]) return ORDER_FIELDS[body.field];
  return null;
}

/** A Hebrew sentence for any error the admin API returns. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return 'משהו השתבש. נסו שוב.';
  if (error.status === 0) return 'אין חיבור לשרת. בדקו את החיבור לאינטרנט.';
  if (error.status === 413) return IMAGE_PROBLEMS.too_large;
  const shipping = shippingMessage(error.error ?? {});
  if (shipping) return shipping;
  const order = orderMessage(error.error ?? {});
  if (order) return order;
  const promotion = promotionMessage(error.error ?? {});
  if (promotion) return promotion;
  const content = contentMessage(error.error ?? {}, error.url);
  if (content) return content;
  const catalog = catalogMessage(error.error ?? {});
  if (catalog) return catalog;
  const body = (error.error ?? {}) as { code?: AuthErrorCode; reason?: string; retryAfterSeconds?: number };
  if (body.code === 'weak_password' && body.reason) return WEAK_PASSWORD[body.reason] ?? MESSAGES.weak_password;
  if (body.code === 'too_many_attempts' && body.retryAfterSeconds) {
    return `${MESSAGES.too_many_attempts} אפשר לנסות שוב בעוד ${waitText(body.retryAfterSeconds)}.`;
  }
  if (body.code && MESSAGES[body.code]) return MESSAGES[body.code];
  return 'משהו השתבש. נסו שוב.';
}

function waitText(seconds: number): string {
  if (seconds < 60) return `${seconds} שניות`;
  const minutes = Math.ceil(seconds / 60);
  return minutes === 1 ? 'דקה' : `${minutes} דקות`;
}
