/**
 * Checkout, orders and payment (Phase 4c, spec §5, CHK-01–04, CHK-06, CHK-09, CHK-10). Money is in agorot
 * (integer, VAT included) and every total is computed by the server.
 */
import type { CartDiscount } from './cart.js';
import type { FulfillmentMode } from './catalog.js';
import type { ShippingMethod, ShippingQuoteLine } from './shipping.js';

export interface CheckoutContact {
  /** 2–80 characters. */
  fullName: string;
  /** Israeli mobile, 05XXXXXXXX (spaces and dashes are removed). */
  phone: string;
  email: string;
}

export interface CheckoutAddress {
  /** CBS locality code (GET /api/localities). */
  localityId: number;
  /** 1–80 characters. */
  street: string;
  /** 1–10 characters. */
  houseNumber: string;
  apartment: string | null;
  /** 0 = ground floor, at most 60. */
  floor: number;
  hasElevator: boolean;
  /** Notes to the courier. */
  notes: string | null;
}

/** POST /api/checkout — the cart comes from the cookie. */
export interface CheckoutRequest {
  contact: CheckoutContact;
  address: CheckoutAddress;
  method: ShippingMethod;
  acceptTerms: true;
}

/** Where to send the customer to pay (the provider's page). Also the answer of POST /api/orders/:number/retry-payment. */
export interface CheckoutResponse {
  redirectUrl: string;
}

/**
 * Error codes of the checkout and order endpoints (`{ statusCode, code, ... }`):
 * - `invalid_field` (400): `field` (e.g. `contact.phone`, `address.floor`) and `messageHe`;
 * - `insufficient_stock` (409): `variantId` and `available` (the line's new limit, 0 when none is left);
 * - `empty_cart` (409): nothing in the cart can be ordered;
 * - `cart_changed` (409): the cart changed while the order was being placed — try again;
 * - `shipping_unavailable` (503): the shipping price list is not configured;
 * - `payment_unavailable` (502): the payment provider did not answer;
 * - `not_retryable` (409): the order is paid or still waiting for its payment;
 * - `superseded` (409): a newer order was placed from the same cart — pay that one instead;
 * - `not_found` (404): unknown order or transaction, or the token does not match;
 * - `invalid_input` (400): a malformed sandbox request; `invalid_signature` (401) / `invalid_payload` (400): webhook.
 */
export type CheckoutErrorCode =
  | 'invalid_field'
  | 'invalid_input'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'insufficient_stock'
  | 'empty_cart'
  | 'cart_changed'
  | 'shipping_unavailable'
  | 'payment_unavailable'
  | 'not_retryable'
  | 'superseded'
  | 'not_found';

/** 400 of POST /api/checkout: the first invalid field. */
export interface CheckoutFieldError {
  statusCode: 400;
  code: 'invalid_field';
  field: string;
  messageHe: string;
}

/** 409 when a line asks for more than can be sold now. */
export interface CheckoutShortage {
  statusCode: 409;
  code: 'insufficient_stock';
  variantId: number;
  available: number;
}

/** `expired`: was waiting for payment and its 20-minute reservation passed (decision 69). */
export type OrderStatus = 'pending_payment' | 'paid' | 'payment_failed' | 'expired';

export interface OrderLine {
  /** Null when the variant was deleted since. */
  variantId: number | null;
  sku: string;
  modelName: string;
  nameHe: string;
  optionLabels: string[];
  unitPrice: number;
  quantity: number;
  lineTotal: number;
}

export interface OrderAddressView extends CheckoutAddress {
  localityNameHe: string;
}

/** GET /api/orders/:number?t=<token> — the confirmation page. */
export interface OrderView {
  number: number;
  status: OrderStatus;
  /** ISO time. */
  createdAt: string;
  /** ISO time until which the stock is held while waiting for payment. */
  reservedUntil: string;
  lines: OrderLine[];
  address: OrderAddressView;
  method: ShippingMethod;
  shippingTotal: number;
  shippingLines: ShippingQuoteLine[];
  subtotal: number;
  discount: number;
  /** Phase 4d; null until then. */
  discountInfo: Pick<CartDiscount, 'labelHe' | 'source' | 'code'> | null;
  total: number;
  deliveryEstimate: { fulfillment: FulfillmentMode; leadTimeDays: number } | null;
  /** Failed or expired, not replaced by a newer order of the same cart, and every line can still be bought: "נסו לשלם שוב" makes a new payment page. */
  canRetryPayment: boolean;
  /** Paid although an in-stock line no longer had enough stock (late payment): staff must contact the customer. */
  stockShortage: boolean;
}

// ---------- Sandbox payment page (development only, CHK-10) ----------

export type SandboxPaymentOutcome = 'success' | 'failure' | 'cancel';

/** POST /api/payments/sandbox/:transactionId/complete */
export interface SandboxCompleteRequest {
  outcome: SandboxPaymentOutcome;
  /** 1–12. */
  installments: number;
}

export interface SandboxCompleteResponse {
  /** Relative storefront URL of the confirmation page: /order/{number}?t={token}. */
  confirmationUrl: string;
}

/** GET /api/payments/sandbox/:transactionId — what the sandbox payment page shows. */
export interface SandboxPaymentView {
  transactionId: string;
  orderNumber: number;
  amount: number;
  status: 'pending' | 'succeeded' | 'failed' | 'cancelled';
}
