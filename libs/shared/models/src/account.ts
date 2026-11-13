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

/**
 * `POST sign-up` (decision 80: an account is created only when both its phone and its e-mail were verified by a code).
 * Without `signUpToken`: checks the details (409 `phone_taken` / `email_taken`), sends a code to the phone and one to
 * the e-mail, answers `{ verify: true }`; nothing is stored. With a `signUpToken` that covers both the phone and the
 * e-mail sent: creates the account (both verified) and signs in; a contact the ticket does not cover → 400
 * `not_verified` with `field: 'phone' | 'email'`.
 */
export interface SignUpBody extends SignUpDetails {
  signUpToken?: string;
}

/**
 * `POST otp/verify`. Purpose `sign_in` (default): signs in the account of that phone or e-mail; without an account it
 * answers a sign-up ticket for the verified contact. Purpose `sign_up`: never signs in; answers a ticket. Passing the
 * `signUpToken` of an earlier answer extends that ticket with this contact, so one ticket can cover both the phone and
 * the e-mail. Tickets live 30 minutes and are used once by `POST sign-up`.
 */
export interface OtpVerifyBody {
  target: string;
  code: string;
  purpose?: 'sign_in' | 'sign_up';
  signUpToken?: string;
}

export interface SignedInResponse {
  customer: CustomerMe;
}

export interface NeedsSignUpResponse {
  needsSignUp: true;
  signUpToken: string;
  /** The contacts the ticket covers (normalized), null where a code is still needed. */
  verified: { phone: string | null; email: string | null };
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
  | 'not_verified'
  | 'wrong_password'
  | 'weak_password'
  | 'phone_taken'
  | 'email_taken'
  | 'not_authenticated'
  | 'too_many_attempts'
  | 'too_many_requests'
  | 'forbidden';
