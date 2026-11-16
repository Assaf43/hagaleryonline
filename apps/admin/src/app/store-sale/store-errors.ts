import { HttpErrorResponse } from '@angular/common/http';
import { errorMessage } from '../core/errors';

/** Codes of the store sale screen (Phase 6), in its own wording. */
const STORE_CODES: Record<string, string> = {
  customer_not_confirmed: 'אישור הלקוח פג. אשרו את הלקוח מחדש.',
  order_pending: 'כבר יש הזמנה שממתינה לתשלום למכירה הזו.',
  customer_email_required: 'לחשבון הזה אין כתובת מייל. הוסיפו מייל בשלב הלקוח.',
  email_taken: 'המייל הזה כבר שייך לחשבון קיים של לקוח.',
  email_not_verified: 'המייל בחשבון הזה עדיין לא אומת, אפשר לשלוח קוד ב-SMS.',
  invalid_code: 'הקוד שגוי או שפג תוקפו. בדקו מול הלקוח ונסו שוב.',
  phone_taken: 'הטלפון הזה כבר שייך לחשבון קיים.',
  not_found: 'לא נמצא. אולי המכירה כבר הסתיימה או הוחלפה.',
  invalid_coupon: 'הקופון לא תקין.',
  unavailable: 'המוצר לא זמין להזמנה כרגע.',
  insufficient_stock: 'אין מספיק מלאי לכמות המבוקשת.',
  empty_cart: 'אין בעגלה מוצרים שאפשר להזמין.',
  cart_changed: 'העגלה השתנתה בזמן ההזמנה. בדקו אותה ונסו שוב.',
  price_changed: 'המחיר השתנה. בדקו את הסיכום ונסו שוב.',
  not_retryable: 'אי אפשר לפתוח שוב את התשלום להזמנה הזו.',
  promotion_ended: 'המבצע או הקופון של ההזמנה הסתיימו. בטלו את ההזמנה והתחילו מכירה חדשה.',
  shipping_unavailable: 'מחירון המשלוחים עדיין לא הוגדר.',
  payment_unavailable: 'ספק התשלום לא ענה. נסו שוב עוד רגע.',
  unknown_locality: 'היישוב לא נמצא. בחרו יישוב מהרשימה.',
};

/** Hebrew for the store sale screen's errors (its own wording where a code means something else elsewhere). */
export function storeErrorMessage(error: unknown): string {
  if (!(error instanceof HttpErrorResponse)) return errorMessage(error);
  if (error.status === 429) return 'יותר מדי ניסיונות בזמן קצר. המתינו רגע ונסו שוב.';
  const body = (error.error ?? {}) as { code?: string; messageHe?: string };
  if (body.code === 'invalid_field' && body.messageHe) return body.messageHe;
  if (body.code === 'coupon_invalid' && body.messageHe) return body.messageHe;
  if (body.code && STORE_CODES[body.code]) return STORE_CODES[body.code];
  return errorMessage(error);
}

/** The API code of an error, for the screens that branch on it. */
export function errorCode(error: unknown): string | null {
  return error instanceof HttpErrorResponse ? ((error.error as { code?: string } | null)?.code ?? null) : null;
}
