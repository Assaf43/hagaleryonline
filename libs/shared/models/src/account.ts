/**
 * Customer accounts (Phase 5c, spec §6.1, §6.2, ACC-01, NFR-12, decision 80): sign-up with phone and e-mail, sign-in
 * by e-mail + password or by a one-time code sent by SMS or e-mail. Endpoints under /api/account/.
 */
import type { MarketingStatus } from './marketing.js';
import type { CheckoutAddress, OrderStatus } from './orders.js';

/** The signed-in customer (`GET /api/account/me`; `null` when signed out). */
export interface CustomerMe {
  id: string;
  fullName: string;
  /** Normalized 05XXXXXXXX. */
  phone: string;
  /**
   * Lower-case. Null for an account without one (a store quick account whose e-mail a website sign-up took, decision
   * 85); it adds one through `contact/change` + `contact/confirm`.
   */
  email: string | null;
  /** A code sent to it was entered (decision 80). */
  phoneVerified: boolean;
  /**
   * False for a store quick account until it confirms its e-mail with `contact/change` (its own e-mail is accepted).
   * An unverified e-mail never signs in (decision 85). Always false when `email` is null.
   */
  emailVerified: boolean;
  hasPassword: boolean;
  /** The account's marketing contact is `subscribed` (decision 95; `GET /api/account/consent` has the details). */
  marketingConsent: boolean;
  /** When the current marketing consent was given (ISO time); null when there is none. */
  marketingConsentAt: string | null;
}

/** `PUT /api/account/name`: 2–80 characters after trimming (400 `invalid_input`, `field: 'name'`); answers the `CustomerMe`. */
export interface NameChangeBody {
  name: string;
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
  | 'forbidden'
  | 'not_found'
  | 'address_limit'
  /** Store confirmation (Phase 6): a code to an e-mail the account has not verified (decision 85). */
  | 'email_not_verified';

// ---------- Account data (Phase 5c Task 12, spec §6.3, ACC-03, ACC-04, ACC-05) ----------

/**
 * A saved delivery address (`GET/POST /api/account/addresses`, `PUT/DELETE /api/account/addresses/:id`): the same
 * fields as the checkout address. Exactly one address is the default while any exist: the first one saved, the one
 * last marked `isDefault: true`, or (after the default is deleted) the newest remaining one. The list is default
 * first, then newest first.
 */
export interface CustomerAddressView extends CheckoutAddress {
  id: string;
  localityNameHe: string;
  isDefault: boolean;
}

/**
 * Body of `POST /api/account/addresses` and `PUT /api/account/addresses/:id`: validated like the checkout address
 * (400 `invalid_field` with `field: 'address.…'` and `messageHe`). `isDefault: true` makes it the default; `false`
 * on the current default leaves it the default (choose another one instead). At most `MAX_CUSTOMER_ADDRESSES`
 * (409 `address_limit`). Another customer's id → 404 `not_found`.
 */
export interface CustomerAddressInput extends CheckoutAddress {
  isDefault?: boolean;
}

export const MAX_CUSTOMER_ADDRESSES = 20;

/** One row of `GET /api/account/orders` (only orders placed while signed in, decision 77). */
export interface AccountOrderSummary {
  number: number;
  /** As the customer sees it: a pending order past its reservation reads `expired`. */
  status: OrderStatus;
  statusLabelHe: string;
  createdAt: string;
  /** Agorot. */
  total: number;
  /** Units over all lines. */
  itemCount: number;
}

/** `GET /api/account/orders?page=` (from 1; 400 otherwise): newest first, `ACCOUNT_ORDERS_PAGE_SIZE` a page. */
export interface AccountOrdersPage {
  items: AccountOrderSummary[];
  page: number;
  pageSize: number;
  /** Orders in all pages. */
  total: number;
}

export const ACCOUNT_ORDERS_PAGE_SIZE = 10;

/**
 * `PUT /api/account/consent { marketingConsent }` (CLAUDE.md §4.4, decision 95): the account's e-mail in the marketing
 * contacts. `true` subscribes the verified e-mail at once (source `account`, a `confirmed` history event); an
 * unverified or missing e-mail answers 409 `email_not_verified`. `false` withdraws it (a `withdrawn` event). Sending
 * the current state changes nothing. Answers the `AccountConsent`.
 */
export interface ConsentBody {
  marketingConsent: boolean;
}

export type MarketingConsentSource = 'signup' | 'checkout' | 'account' | 'store' | 'newsletter';

/**
 * `GET` / `PUT /api/account/consent`: the marketing contact of the account's e-mail. `status` null: that e-mail never
 * had one. `pending` waits for the customer's confirmation link (a store or guest-checkout request). `consentAt` is the
 * time of the current consent (null unless `subscribed`). `emailVerified` false: the account must verify its e-mail
 * before it can subscribe here.
 */
export interface AccountConsent {
  status: MarketingStatus | null;
  source: MarketingConsentSource | null;
  consentAt: string | null;
  emailVerified: boolean;
}

// ---------- Club benefits (Phase 7c, spec §4.3, decisions 93–94) ----------

/**
 * A personal code's state in "ההטבות שלי": `used` by a paid order; `expired` past its expiry, its template turned off
 * (that voids unused codes), or — a welcome code — once the account has a paid order; `active` otherwise.
 */
export type AccountBenefitStatus = 'active' | 'used' | 'expired';

/**
 * One row of `GET /api/account/benefits` (no-store): the account's own personal codes (the welcome code and codes from
 * staff), newest first. `labelHe` is the template's name (the same label the cart's discount line shows), `expiresAt`
 * an ISO time (never after the template's end).
 */
export interface AccountBenefit {
  code: string;
  labelHe: string;
  expiresAt: string;
  status: AccountBenefitStatus;
}
