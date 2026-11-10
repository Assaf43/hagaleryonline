import { DOCUMENT, Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  CheckoutErrorCode,
  CheckoutRequest,
  CheckoutResponse,
  LocalityOption,
  OrderView,
  SandboxCompleteRequest,
  SandboxCompleteResponse,
  SandboxPaymentView,
  ShippingErrorCode,
  ShippingMethod,
  ShippingQuote,
  ShippingQuoteRequest,
} from '@hg/models';

/**
 * Checkout, order and sandbox payment calls (Phase 4c, spec §5). All same-origin, so the cart cookie goes along
 * and the API's StorefrontOriginGuard lets the writes through. These are only called in the browser.
 */
@Injectable({ providedIn: 'root' })
export class CheckoutApi {
  private readonly http = inject(HttpClient);

  /** An observable, so a newer search can cancel the one in flight. */
  localities(q: string) {
    return this.http.get<LocalityOption[]>('/api/localities', { params: { q } });
  }

  quote(body: ShippingQuoteRequest) {
    return this.http.post<ShippingQuote>('/api/shipping/quote', body);
  }

  checkout(body: CheckoutRequest) {
    return firstValueFrom(this.http.post<CheckoutResponse>('/api/checkout', body));
  }

  order(number: string, token: string) {
    return firstValueFrom(
      this.http.get<OrderView>(`/api/orders/${encodeURIComponent(number)}`, { params: { t: token } }),
    );
  }

  retryPayment(number: string, token: string) {
    return firstValueFrom(
      this.http.post<CheckoutResponse>(`/api/orders/${encodeURIComponent(number)}/retry-payment`, null, {
        params: { t: token },
      }),
    );
  }

  sandboxPayment(transactionId: string) {
    return firstValueFrom(
      this.http.get<SandboxPaymentView>(`/api/payments/sandbox/${encodeURIComponent(transactionId)}`),
    );
  }

  completeSandboxPayment(transactionId: string, body: SandboxCompleteRequest) {
    return firstValueFrom(
      this.http.post<SandboxCompleteResponse>(
        `/api/payments/sandbox/${encodeURIComponent(transactionId)}/complete`,
        body,
      ),
    );
  }
}

/** Leaves the app for the payment provider's page (a full page load, possibly to another origin). */
@Injectable({ providedIn: 'root' })
export class ExternalNavigation {
  private readonly document = inject(DOCUMENT);

  assign(url: string): void {
    this.document.location.assign(url);
  }
}

/** Shipping methods as the customer sees them (spec §4.1). */
export const SHIPPING_METHOD_LABELS_HE: Record<ShippingMethod, string> = {
  curbside: 'עד נקודת הפריקה',
  full_service: 'כולל סבלות והרכבה',
};

/** Codes this file turns into Hebrew: checkout/order/payment codes plus the quote's `unknown_locality`. */
export type ApiErrorCode = CheckoutErrorCode | ShippingErrorCode;

/** The `code` of an API error body, or null (network error, other shape). */
export function apiErrorCode(error: unknown): ApiErrorCode | null {
  if (!(error instanceof HttpErrorResponse)) return null;
  const body: unknown = error.error;
  if (typeof body === 'object' && body !== null && typeof (body as { code?: unknown }).code === 'string') {
    return (body as { code: ApiErrorCode }).code;
  }
  return null;
}

/** Hebrew for the checkout, order and payment error codes that have no field of their own. */
export function checkoutErrorMessage(code: ApiErrorCode | null): string {
  switch (code) {
    case 'insufficient_stock':
      return 'חלק מהפריטים כבר לא זמינים בכמות שביקשתם. עדכנו את הסל.';
    case 'empty_cart':
      return 'אין בסל מוצרים שאפשר להזמין.';
    case 'cart_changed':
      return 'הסל השתנה בזמן ההזמנה. בדקו את הסיכום ונסו שוב.';
    case 'shipping_unavailable':
      return 'המשלוח אינו זמין כרגע. נסו שוב מאוחר יותר.';
    case 'payment_unavailable':
      return 'לא הצלחנו לפתוח את עמוד התשלום. נסו שוב בעוד רגע.';
    case 'not_retryable':
      return 'אי אפשר לשלם שוב על ההזמנה הזאת. רעננו את הדף כדי לראות את מצבה.';
    case 'superseded':
      return 'נוצרה הזמנה חדשה יותר מאותו סל, ולכן אי אפשר לשלם על ההזמנה הזאת. חזרו לסל כדי להמשיך.';
    case 'unknown_locality':
      return 'יש לבחור יישוב מהרשימה';
    case 'invalid_input':
      return 'הנתונים שנשלחו לא תקינים. נסו שוב.';
    case 'not_found':
      return 'לא מצאנו את מה שחיפשתם.';
    default:
      return 'משהו השתבש. נסו שוב.';
  }
}
