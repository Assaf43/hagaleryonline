/**
 * Customer accounts (Phase 5c, spec §6.1, §6.2, ACC-01, NFR-12, decision 80): sign-up with phone and e-mail, sign-in
 * by e-mail + password or by a one-time code sent by SMS or e-mail. Endpoints under /api/account/.
 */

/** The signed-in customer (`GET /api/account/me`; `null` when signed out). */
export interface CustomerMe {
  id: string;
  fullName: string;
  /** Normalized 05XXXXXXXX. */
  phone: string;
  /** Lower-case. */
  email: string;
  /** A code sent to it was entered (decision 80). */
  phoneVerified: boolean;
  emailVerified: boolean;
  hasPassword: boolean;
  marketingConsent: boolean;
}

/** Where a code is sent: `sms` to a phone, `email` to an e-mail address. */
export type OtpChannel = 'sms' | 'email';
/** Purposes a browser can ask a code for with `POST otp/request`. */
export type OtpRequestPurpose = 'sign_in' | 'sign_up';

/** `POST /api/account/otp/request` → always 202 `{ sent: true }` (no account enumeration), or 429. */
export interface OtpRequestBody {
  target: string;
  channel: OtpChannel;
  purpose: OtpRequestPurpose;
}

export interface OtpSentResponse {
  sent: true;
}

/** The details of a new account (`POST sign-up`, and `POST otp/verify` with purpose `sign_up`). */
export interface SignUpDetails {
  fullName: string;
  phone: string;
  email: string;
  /** Optional; 8–128 characters. */
  password?: string;
  /** The unchecked-by-default checkbox (§4.4): stored with its time and source `signup`. */
  marketingConsent: boolean;
}

/** `POST sign-up`: with `signUpToken` (from a verified code) the account is created at once; without, a code goes to the phone. */
export interface SignUpBody extends SignUpDetails {
  signUpToken?: string;
}

/**
 * `POST otp/verify`: purpose `sign_in` (default) signs in, or, for a phone or e-mail without an account, returns a
 * sign-up ticket (30 minutes, single use). Purpose `sign_up` resends the sign-up details with the code sent to the
 * phone by `POST sign-up` (the server keeps nothing pending): `target` is the phone.
 */
export type OtpVerifyBody =
  | { target: string; code: string; purpose?: 'sign_in' }
  | ({ target: string; code: string; purpose: 'sign_up' } & Omit<SignUpDetails, 'phone'>);

export interface SignedInResponse {
  customer: CustomerMe;
}

export interface NeedsSignUpResponse {
  needsSignUp: true;
  signUpToken: string;
}

export type OtpVerifyResponse = SignedInResponse | NeedsSignUpResponse;
export type SignUpResponse = SignedInResponse | { verify: true };

export interface SignInBody {
  email: string;
  password: string;
}

/** `POST password`: `current` is required when the account already has a password. */
export interface PasswordChangeBody {
  current?: string;
  next: string;
}

/** `POST contact/change` sends a code to the new value; `POST contact/confirm` with that code saves it as verified. */
export interface ContactChangeBody {
  kind: 'phone' | 'email';
  value: string;
}

export interface ContactConfirmBody {
  kind: 'phone' | 'email';
  code: string;
}

export interface PasswordResetRequestBody {
  email: string;
}

export interface PasswordResetBody {
  email: string;
  code: string;
  next: string;
}

/** Customer password length (the plan's bounds; no strength score, unlike the admin's). */
export const CUSTOMER_PASSWORD_MIN = 8;
export const CUSTOMER_PASSWORD_MAX = 128;

/** The one answer to every code request, whatever the case (spec §6.1). */
export const CODE_SENT_MESSAGE_HE = 'אם קיים חשבון, שלחנו קוד';

/** Error codes of /api/account/ (`{ statusCode, code, field? }`). */
export type AccountErrorCode =
  | 'invalid_input'
  | 'invalid_code'
  | 'invalid_credentials'
  | 'invalid_token'
  | 'wrong_password'
  | 'weak_password'
  | 'phone_taken'
  | 'email_taken'
  | 'not_authenticated'
  | 'too_many_attempts'
  | 'too_many_requests'
  | 'forbidden';
