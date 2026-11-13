import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AccountConsent,
  AccountErrorCode,
  AccountOrdersPage,
  ConsentBody,
  NameChangeBody,
  ContactChangeBody,
  ContactConfirmBody,
  CustomerAddressInput,
  CustomerAddressView,
  CustomerMe,
  OrderView,
  OtpRequestBody,
  OtpSentResponse,
  OtpVerifyBody,
  OtpVerifyResponse,
  PasswordChangeBody,
  PasswordResetBody,
  PasswordResetRequestBody,
  SignInBody,
  SignUpBody,
  SignUpResponse,
  SignedInResponse,
} from '@hg/models';

/**
 * The customer account API (Phase 5c, spec §6). Same-origin calls, so the `hg_customer` cookie goes along and the
 * API's StorefrontOriginGuard lets the writes through. Only called in the browser.
 */
@Injectable({ providedIn: 'root' })
export class AccountApi {
  private readonly http = inject(HttpClient);

  /** `null` when signed out. */
  me() {
    return firstValueFrom(this.http.get<CustomerMe | null>('/api/account/me'));
  }

  requestOtp(body: OtpRequestBody) {
    return firstValueFrom(this.http.post<OtpSentResponse>('/api/account/otp/request', body));
  }

  verifyOtp(body: OtpVerifyBody) {
    return firstValueFrom(this.http.post<OtpVerifyResponse>('/api/account/otp/verify', body));
  }

  signUp(body: SignUpBody) {
    return firstValueFrom(this.http.post<SignUpResponse>('/api/account/sign-up', body));
  }

  signIn(body: SignInBody) {
    return firstValueFrom(this.http.post<SignedInResponse>('/api/account/sign-in', body));
  }

  signOut() {
    return firstValueFrom(this.http.post<void>('/api/account/sign-out', null));
  }

  requestReset(body: PasswordResetRequestBody) {
    return firstValueFrom(this.http.post<OtpSentResponse>('/api/account/password/reset/request', body));
  }

  reset(body: PasswordResetBody) {
    return firstValueFrom(this.http.post<SignedInResponse>('/api/account/password/reset', body));
  }

  changePassword(body: PasswordChangeBody) {
    return firstValueFrom(this.http.post<SignedInResponse>('/api/account/password', body));
  }

  changeName(name: string) {
    const body: NameChangeBody = { name };
    return firstValueFrom(this.http.put<CustomerMe>('/api/account/name', body));
  }

  changeContact(body: ContactChangeBody) {
    return firstValueFrom(this.http.post<OtpSentResponse>('/api/account/contact/change', body));
  }

  confirmContact(body: ContactConfirmBody) {
    return firstValueFrom(this.http.post<SignedInResponse>('/api/account/contact/confirm', body));
  }

  addresses() {
    return firstValueFrom(this.http.get<CustomerAddressView[]>('/api/account/addresses'));
  }

  createAddress(body: CustomerAddressInput) {
    return firstValueFrom(this.http.post<CustomerAddressView>('/api/account/addresses', body));
  }

  updateAddress(id: string, body: CustomerAddressInput) {
    return firstValueFrom(this.http.put<CustomerAddressView>(`/api/account/addresses/${encodeURIComponent(id)}`, body));
  }

  deleteAddress(id: string) {
    return firstValueFrom(this.http.delete<void>(`/api/account/addresses/${encodeURIComponent(id)}`));
  }

  orders(page: number) {
    return firstValueFrom(this.http.get<AccountOrdersPage>('/api/account/orders', { params: { page } }));
  }

  order(number: string) {
    return firstValueFrom(this.http.get<OrderView>(`/api/account/orders/${encodeURIComponent(number)}`));
  }

  cancelOrder(number: string) {
    return firstValueFrom(this.http.post<OrderView>(`/api/account/orders/${encodeURIComponent(number)}/cancel`, null));
  }

  setConsent(marketingConsent: boolean) {
    const body: ConsentBody = { marketingConsent };
    return firstValueFrom(this.http.put<AccountConsent>('/api/account/consent', body));
  }
}

/** What the storefront reads from an API error. */
export interface AccountFailure {
  /** HTTP status; 0 for a network error. */
  status: number;
  code: AccountErrorCode | 'invalid_field' | 'invalid_transition' | null;
  field: string | null;
  /** The API's own Hebrew text (checkout-style field errors). */
  messageHe: string | null;
}

export function accountFailure(error: unknown): AccountFailure {
  if (!(error instanceof HttpErrorResponse)) return { status: 0, code: null, field: null, messageHe: null };
  const body: Record<string, unknown> =
    typeof error.error === 'object' && error.error !== null ? (error.error as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : null);
  return {
    status: error.status,
    code: str(body['code']) as AccountFailure['code'],
    field: str(body['field']),
    messageHe: str(body['messageHe']),
  };
}

export const TOO_MANY_MESSAGE_HE = 'ביצעתם יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.';
export const GENERIC_ERROR_MESSAGE_HE = 'משהו השתבש. נסו שוב.';
export const SIGN_IN_FAILED_MESSAGE_HE = 'פרטי ההתחברות שגויים';

/** Hebrew for an account error (a 429 always reads "too many attempts", whatever its code). */
export function accountErrorMessage(failure: AccountFailure): string {
  if (failure.status === 429) return TOO_MANY_MESSAGE_HE;
  switch (failure.code) {
    case 'invalid_credentials':
      return SIGN_IN_FAILED_MESSAGE_HE;
    case 'invalid_code':
      return 'הקוד שגוי או שפג תוקפו';
    case 'invalid_token':
      return 'האימות פג תוקף. התחילו מחדש.';
    case 'not_verified':
      return 'יש לאמת את הטלפון והדוא״ל בקוד שנשלח';
    case 'wrong_password':
      return 'הסיסמה הנוכחית שגויה';
    case 'weak_password':
      return 'הסיסמה צריכה להיות באורך של 8 עד 128 תווים';
    case 'phone_taken':
      return 'מספר הטלפון הזה כבר רשום';
    case 'email_taken':
      return 'כתובת הדוא״ל הזאת כבר רשומה';
    case 'address_limit':
      return 'אפשר לשמור עד 20 כתובות';
    case 'invalid_field':
      return failure.messageHe ?? GENERIC_ERROR_MESSAGE_HE;
    case 'not_found':
      return 'לא מצאנו את מה שחיפשתם.';
    default:
      return GENERIC_ERROR_MESSAGE_HE;
  }
}
