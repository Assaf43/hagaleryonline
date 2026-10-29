import { HttpErrorResponse } from '@angular/common/http';
import type { AuthErrorCode } from '@hg/models';

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

/** A Hebrew sentence for any error the admin API returns. */
export function errorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return 'משהו השתבש. נסו שוב.';
  if (error.status === 0) return 'אין חיבור לשרת. בדקו את החיבור לאינטרנט.';
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
