/** Seller-assisted store orders (Phase 6, ADM-18, spec §4.4–§4.6). */
import type { CartView } from './cart.js';
import type { MarketingStatus } from './marketing.js';
import type { CheckoutAddress, OrderStatus } from './orders.js';
import type { ShippingMethod } from './shipping.js';

/** The one physical store: shown only in the admin (decision 43). */
export interface StoreInfo {
  id: number;
  nameHe: string;
  address: string;
  hoursHe: string;
  phone: string;
}

/** The customer a seller attached to the store cart (spec §4.2). `isNew`: created at the store, no paid order yet. */
export interface StoreCustomer {
  id: string;
  fullName: string;
  phone: string;
  email: string | null;
  emailVerified: boolean;
  isNew: boolean;
  /**
   * The marketing contact of the customer's e-mail (decision 96): null when it has none. The seller's marketing box
   * needs an e-mail (`email` null → disabled); `pending` waits for the customer's SMS link, `subscribed` needs none.
   */
  marketingStatus: MarketingStatus | null;
}

/** The store cart: the website cart's view plus the attached customer. */
export type StoreCartView = CartView & { customer: StoreCustomer | null };

/**
 * `POST /api/admin/store-cart/customer/lookup` `{ phone }` (spec §4.1 step 2): whether the phone has an account, and
 * what the seller may show of it. `maskedEmail` is null for an account without an e-mail; a code goes to the e-mail
 * only when `emailVerified` (decision 85).
 */
export type StoreCustomerLookup =
  { exists: false } | { exists: true; fullName: string; maskedEmail: string | null; emailVerified: boolean };

/** Where the confirmation code goes: the phone, or the account's verified e-mail. A new phone takes `sms` only. */
export type StoreCodeChannel = 'sms' | 'email';

/**
 * The details the seller types for a new phone (a quick account: `fullName` and `email`, both required), or only
 * `email` for an existing account that has none (saved unverified).
 */
export interface StoreNewCustomer {
  fullName?: string;
  email: string;
}

/**
 * `POST /api/admin/store-cart/customer/code` → 204. Exactly one key: `phone`, or `email` — the verified e-mail of an
 * existing account (spec §4.1 step 2: a new phone whose e-mail is the customer's own older account → 409
 * `email_taken`, then that account by an e-mail code). With `email` the channel is `email` and there is no
 * `newCustomer`; an unknown or unverified e-mail answers 404 `not_found`.
 */
export type StoreCodeRequest =
  | { phone: string; email?: never; channel: StoreCodeChannel; newCustomer?: StoreNewCustomer }
  | { email: string; phone?: never; channel: 'email'; newCustomer?: never };

/** `POST /api/admin/store-cart/customer/verify` → `StoreCartView` with the confirmed customer. */
export type StoreVerifyRequest = StoreCodeRequest & { code: string };

/**
 * `POST /api/admin/store-orders` (spec §4.4): the seller's open cart becomes an order on the website's checkout path,
 * for the confirmed customer (the contact is the account's). `saveAddress` (default true) adds the address to the
 * account when it is not there yet. Errors are the checkout's plus `customer_not_confirmed`,
 * `customer_email_required` and `order_pending` (`{ number }`).
 */
export interface StoreOrderRequest {
  address: CheckoutAddress;
  method: ShippingMethod;
  acceptTerms: true;
  /** Agorot: the total on the seller screen (the store cart view plus the chosen shipping method). */
  expectedTotal: number;
  /**
   * Ticked for the customer, never pre-checked; stored on the order. The customer gets an SMS link and consent is
   * recorded only when they confirm it (source `store`, decision 96); an already subscribed e-mail gets nothing.
   */
  marketingConsent?: boolean;
  saveAddress?: boolean;
}

/** The order number and the provider's payment page, opened on the tablet. */
export interface StoreOrderCreated {
  number: number;
  redirectUrl: string;
}

/** `GET /api/admin/store-orders/:number` — the seller's own store order (404 for any other). */
export interface StoreOrderStatus {
  number: number;
  status: OrderStatus;
  /** Agorot. */
  total: number;
}

/**
 * `GET /api/admin/store-orders/pending` — the seller's store orders not paid yet: waiting for the payment within the
 * reservation, or failed (retry). Newest first.
 */
export interface StorePendingOrder {
  number: number;
  fullName: string;
  /** Agorot. */
  total: number;
  status: 'pending_payment' | 'payment_failed';
  reservedUntil: string;
  /** What the seller may do now, computed on the server by the endpoints' own rules. */
  actions: StorePendingAction[];
}

/**
 * `retry`: a new payment page (`POST …/:number/retry`) — for a failed order, and for one still waiting whose page was
 * closed (the old page is closed with it); `cancel`: `POST …/:number/cancel` (waiting or failed, never paid).
 */
export type StorePendingAction = 'retry' | 'cancel';

/** `POST /api/admin/store-orders/:number/retry` → a new payment page (returns to `/pay/done`). */
export interface StoreOrderRetry {
  redirectUrl: string;
}
