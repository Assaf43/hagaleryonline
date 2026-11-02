import { HttpErrorResponse } from '@angular/common/http';
import type { ActivationProblem, AuthErrorCode, CatalogErrorCode } from '@hg/models';

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
};

const ACTIVATION: Record<ActivationProblem, string> = {
  no_variants: 'צריך לפחות וריאנט פעיל אחד',
  category_hidden: 'הקטגוריה מוסתרת',
};

/** "variants.3.price" → "מחיר בשורה 4"; "slug" → "כתובת באתר". */
export function fieldLabel(field: string): string {
  const variant = /^variants\.(\d+)\.(\w+)$/.exec(field);
  if (variant) return `${FIELDS[variant[2]] ?? variant[2]} בשורה ${Number(variant[1]) + 1}`;
  return FIELDS[field] ?? field;
}

function catalogMessage(body: {
  code?: CatalogErrorCode;
  field?: string;
  value?: string;
  reasons?: ActivationProblem[];
}): string | null {
  switch (body.code) {
    case 'conflict':
      return 'מישהו אחר שמר את המוצר בזמן שעבדתם עליו. טענו אותו מחדש כדי לראות את השינויים, ואז ערכו שוב.';
    case 'duplicate':
      return `${fieldLabel(body.field ?? '')}${body.value ? ` "${body.value}"` : ''} כבר קיים. בחרו ערך אחר.`;
    case 'invalid':
      return `יש לבדוק את השדה: ${fieldLabel(body.field ?? '')}.`;
    case 'in_use':
      return 'אי אפשר למחוק, כי יש מוצרים שמשתמשים בזה.';
    case 'incomplete':
      return `אי אפשר להציג את המוצר באתר עדיין: ${(body.reasons ?? []).map((r) => ACTIVATION[r]).join(', ')}.`;
    case 'not_found':
      return 'הפריט לא נמצא. ייתכן שנמחק.';
    default:
      return null;
  }
}

/** Why a row of an Excel import was refused by the product checks (short, for the issues table). */
export function catalogIssueText(code: CatalogErrorCode): string {
  const text: Record<CatalogErrorCode, string> = {
    invalid: 'הערך לא תקין (למשל מחיר לפני הנחה שלא גבוה מהמחיר)',
    duplicate: 'הערך כבר קיים במוצר אחר',
    conflict: 'המוצר השתנה בזמן הייבוא. נסו שוב',
    in_use: 'בשימוש',
    incomplete: 'חסר מידע כדי להציג את המוצר',
    not_found: 'לא נמצא',
  };
  return text[code];
}

/** A Hebrew sentence for any error the admin API returns. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return 'משהו השתבש. נסו שוב.';
  if (error.status === 0) return 'אין חיבור לשרת. בדקו את החיבור לאינטרנט.';
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
