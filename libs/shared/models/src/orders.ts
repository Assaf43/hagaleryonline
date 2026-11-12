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

// ---------- Checkout validation (spec §5.1): one set of rules for the API and the storefront ----------

/** Length limits of the checkout fields (characters, after trimming). */
export const CHECKOUT_LIMITS = {
  fullNameMin: 2,
  fullNameMax: 80,
  emailMax: 254,
  streetMax: 80,
  houseNumberMax: 10,
  apartmentMax: 10,
  notesMax: 500,
} as const;

/** Israeli mobile after spaces and dashes are removed. */
export const CHECKOUT_PHONE_PATTERN = /^05\d{8}$/;
export const CHECKOUT_EMAIL_PATTERN = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;

/** Fields a checkout 400 can name (`field`), in the order the form shows them. */
export const CHECKOUT_FIELDS = [
  'contact.fullName',
  'contact.phone',
  'contact.email',
  'address.localityId',
  'address.street',
  'address.houseNumber',
  'address.apartment',
  'address.floor',
  'address.hasElevator',
  'address.notes',
  'method',
  'acceptTerms',
] as const;

export type CheckoutField = (typeof CHECKOUT_FIELDS)[number];

/** The Hebrew message of each invalid field (`messageHe` of a 400; the storefront shows the same before sending). */
export const CHECKOUT_FIELD_MESSAGES_HE: Record<CheckoutField, string> = {
  'contact.fullName': 'יש למלא שם מלא (2–80 תווים)',
  'contact.phone': 'יש להזין מספר טלפון נייד תקין, למשל 050-1234567',
  'contact.email': 'יש להזין כתובת דוא״ל תקינה',
  'address.localityId': 'יש לבחור יישוב מהרשימה',
  'address.street': 'יש למלא רחוב (עד 80 תווים)',
  'address.houseNumber': 'יש למלא מספר בית (עד 10 תווים)',
  'address.apartment': 'מספר הדירה ארוך מדי (עד 10 תווים)',
  'address.floor': 'יש להזין קומה בין 0 ל־60',
  'address.hasElevator': 'יש לציין אם יש מעלית',
  'address.notes': 'ההערות לשליח ארוכות מדי (עד 500 תווים)',
  method: 'יש לבחור שיטת משלוח',
  acceptTerms: 'יש לאשר את תנאי השימוש',
};

/** POST /api/checkout — the cart comes from the cookie. */
export interface CheckoutRequest {
  contact: CheckoutContact;
  address: CheckoutAddress;
  method: ShippingMethod;
  acceptTerms: true;
  /**
   * Agorot: the total the customer saw, shipping included. Required (400 `invalid_input` without it); when it differs
   * from the recomputed total the order is not placed (409 `price_changed`).
   */
  expectedTotal: number;
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
 * - `price_changed` (409): the total differs from `expectedTotal`; `total` is the new one (agorot);
 * - `coupon_invalid` (409): the cart's coupon was used up in the meantime; `field: 'coupon'` and `messageHe`
 *   (`CouponErrorBody`) — remove it and try again;
 * - `too_many_requests` (429): per-IP limit of a public write; `retryAfterSeconds`;
 * - `shipping_unavailable` (503): the shipping price list is not configured;
 * - `payment_unavailable` (502): the payment provider did not answer;
 * - `not_retryable` (409): the order is paid or still waiting for its payment;
 * - `promotion_ended` (409): retry refused — the order's promotion or coupon ended, is inactive or used up;
 *   `messageHe`;
 * - `superseded` (409): a newer order was placed from the same cart — pay that one instead;
 * - `invalid_transition` (409): the move is not allowed from the order's status (or the customer cannot cancel it);
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
  | 'price_changed'
  | 'coupon_invalid'
  | 'too_many_requests'
  | 'shipping_unavailable'
  | 'payment_unavailable'
  | 'not_retryable'
  | 'promotion_ended'
  | 'superseded'
  | 'invalid_transition'
  | 'refund_exceeds_paid'
  | 'already_answered'
  | 'slot_closed'
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
export type OrderStatus =
  | 'pending_payment'
  | 'paid'
  | 'processing'
  | 'delivery_scheduled'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'payment_failed'
  | 'expired';

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

export type DeliverySlotState = 'proposed' | 'confirmed' | 'change_requested' | 'superseded';

/** How the admin order detail names the state of the delivery slot. */
export const DELIVERY_SLOT_STATE_LABELS_HE: Record<DeliverySlotState, string> = {
  proposed: 'הוצע',
  confirmed: 'אושר על ידי הלקוח',
  change_requested: 'הלקוח ביקש מועד אחר',
  superseded: 'הוחלף',
};

/** The delivery date and time window staff set for an order (Phase 5, spec §4.1). */
export interface DeliverySlotView {
  /** Israel-time calendar date, YYYY-MM-DD. */
  date: string;
  /** Local 24-hour times, HH:MM. */
  windowFrom: string;
  windowTo: string;
  state: DeliverySlotState;
}

/** GET /api/delivery/:token — what the delivery confirmation page shows (spec §5.3). */
export interface DeliveryLinkView {
  orderNumber: number;
  /** Israel-time calendar date, YYYY-MM-DD. */
  date: string;
  windowFrom: string;
  windowTo: string;
  state: DeliverySlotState;
}

/** POST /api/delivery/:token — the customer's answer; `note` is optional, at most 500 characters. */
export interface DeliveryAnswerRequest {
  answer: 'confirm' | 'change';
  note?: string;
}

// ---------- Invoices (Phase 5b, spec §5.4, CHK-08, decision 81) ----------

/** A tax invoice / receipt when the order is paid; a credit note for each succeeded refund. */
export type InvoiceType = 'tax_invoice_receipt' | 'credit_note';

/** How the storefront and the admin name each document (followed by its number). */
export const INVOICE_TYPE_LABELS_HE: Record<InvoiceType, string> = {
  tax_invoice_receipt: 'חשבונית מס/קבלה',
  credit_note: 'חשבונית זיכוי',
};

/**
 * One issued document of an order, oldest first. The customer opens it at
 * `GET /api/orders/:number/invoices/:id?t=<order token>`, staff at `GET /api/admin/invoices/:id/document`
 * (`invoices.export`).
 */
export interface OrderInvoiceView {
  id: string;
  type: InvoiceType;
  /** The provider's document number, e.g. `MOCK-INV-000042`. */
  number: string;
  /** ISO time. */
  issuedAt: string;
}

/** GET /api/orders/:number?t=<token> — the confirmation page. */
export interface OrderView {
  /** The order's tax invoice and credit notes, oldest first (empty until the first one is issued). */
  invoices: OrderInvoiceView[];
  number: number;
  status: OrderStatus;
  /** Hebrew label of `status` (ORDER_STATUS_LABELS_HE). */
  statusLabelHe: string;
  /** The customer may cancel it now (only while waiting for payment, spec §4.2). */
  canCancel: boolean;
  /** Agorot refunded so far. */
  refundedTotal: number;
  /** The current (not superseded) delivery slot, or null. */
  deliverySlot: DeliverySlotView | null;
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
  /** The applied promotion (Phase 4d); null when the order has no discount. */
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

// ---------- Admin: orders (read-only) and providers (Phase 4c, spec §5.5, ADM-13) ----------

/** Hebrew label of each order status, as shown in the admin. */
export const ORDER_STATUS_LABELS_HE: Record<OrderStatus, string> = {
  pending_payment: 'ממתינה לתשלום',
  paid: 'שולמה',
  processing: 'בהכנה',
  delivery_scheduled: 'אספקה מתואמת',
  shipped: 'במשלוח',
  delivered: 'סופקה',
  cancelled: 'בוטלה',
  payment_failed: 'התשלום נכשל',
  expired: 'פג תוקף',
};

/**
 * Why an order needs staff: `stock_shortage` (paid, stock was short), `paid_twice` (a second payment succeeded),
 * `amount_mismatch` (the provider reported another amount), `superseded_paid` (paid although a newer order of the
 * same cart exists, so the customer may pay twice).
 */
export type OrderAttentionReason =
  | 'stock_shortage'
  | 'paid_twice'
  | 'amount_mismatch'
  | 'superseded_paid'
  /** A payment that arrived after the order was cancelled (it is refunded in full). */
  | 'late_payment'
  /** Staff-visible flag with a note: a failed refund, a late payment on a cancelled order (`attentionNote`). */
  | 'flagged'
  /** An outbox job of the order (e-mail, SMS, invoice, refund) failed after all its retries. */
  | 'job_failed';

/** Hebrew label of each attention reason, shown next to the order in the admin. */
export const ORDER_ATTENTION_LABELS_HE: Record<OrderAttentionReason, string> = {
  stock_shortage: 'שולמה אבל המלאי לא הספיק',
  paid_twice: 'שולמה פעמיים',
  amount_mismatch: 'סכום התשלום לא תואם להזמנה',
  superseded_paid: 'שולמה למרות שנוצרה הזמנה חדשה מאותו סל',
  late_payment: 'תשלום התקבל אחרי ביטול',
  flagged: 'דורשת טיפול',
  job_failed: 'משימה אוטומטית נכשלה',
};

/** One row of GET /api/admin/orders. */
export interface AdminOrderRow {
  number: number;
  /** ISO time. */
  createdAt: string;
  customerName: string;
  phone: string;
  total: number;
  /** A pending order past its reservation reads as expired. */
  status: OrderStatus;
  itemCount: number;
  /** Staff must look at it: see `attentionReasons`. */
  needsAttention: boolean;
  attentionReasons: OrderAttentionReason[];
}

export interface AdminOrderPage {
  items: AdminOrderRow[];
  total: number;
  page: number;
  pageSize: number;
}

export type AdminPaymentStatus = 'pending' | 'succeeded' | 'failed' | 'cancelled';

/** A payment attempt: the provider's transaction, never card data (NFR-10). */
export interface AdminOrderPayment {
  provider: string;
  transactionId: string;
  status: AdminPaymentStatus;
  installments: number | null;
  /** Agorot. */
  amount: number;
  rawStatus: string | null;
  /** ISO time. */
  createdAt: string;
}

/** GET /api/admin/orders/:number */
export interface AdminOrderDetail {
  number: number;
  status: OrderStatus;
  createdAt: string;
  reservedUntil: string;
  contact: CheckoutContact;
  address: OrderAddressView;
  method: ShippingMethod;
  shippingTotal: number;
  shippingLines: ShippingQuoteLine[];
  subtotal: number;
  discount: number;
  discountInfo: OrderView['discountInfo'];
  total: number;
  deliveryEstimate: OrderView['deliveryEstimate'];
  lines: OrderLine[];
  /** Paid with an in-stock line short of stock: staff must contact the customer. */
  stockShortage: boolean;
  needsAttention: boolean;
  attentionReasons: OrderAttentionReason[];
  paymentProvider: string;
  shippingProvider: string;
  payments: AdminOrderPayment[];
  /** Agorot refunded so far. */
  refundedTotal: number;
  /** Agorot that can still be refunded now: paid − refunded − pending refunds. */
  refundable: number;
  /** The note of the order's "needs attention" flag (failed refund, late payment), or null. */
  attentionNote: string | null;
  /** Refunds, oldest first. */
  refunds: AdminRefund[];
  /** The current (not superseded) delivery slot, or null. */
  deliverySlot: DeliverySlotView | null;
  /** Staff may cancel it now (with `orders.cancel`): the API's rule, so the admin never repeats it. */
  canCancel: boolean;
  /** The statuses the order can be advanced to now, in flow order. */
  nextStatuses: OrderStatus[];
  /** Status changes, oldest first. */
  statusEvents: AdminOrderStatusEvent[];
  /** The order's tax invoice and credit notes, oldest first. */
  invoices: OrderInvoiceView[];
}

export type RefundStatus = 'pending' | 'succeeded' | 'failed';

/** One refund of an order (spec §4.3). */
export interface AdminRefund {
  id: string;
  /** Agorot. */
  amount: number;
  reason: string;
  status: RefundStatus;
  provider: string;
  adminUserId: number | null;
  error: string | null;
  /** ISO time. */
  createdAt: string;
}

/** What staff decide on a cancel of a paid order (decision 74). */
export type CancelRefundChoice = 'full' | 'partial' | 'none';

/** POST /api/admin/orders/:number/cancel */
export interface AdminCancelRequest {
  refund: CancelRefundChoice;
  /** Agorot; required for `partial`. */
  amount?: number;
  /** 3–500 characters. */
  reason: string;
  /** Return the lines' quantities to stock (paid orders only; default true). */
  restock?: boolean;
}

/** POST /api/admin/orders/:number/refunds */
export interface AdminRefundRequest {
  /** Agorot. */
  amount: number;
  reason: string;
}

export type OrderActorType = 'admin' | 'customer' | 'system';

export interface AdminOrderStatusEvent {
  fromStatus: OrderStatus | null;
  toStatus: OrderStatus;
  actorType: OrderActorType;
  actorAdminId: number | null;
  note: string | null;
  /** ISO time. */
  createdAt: string;
}

/** The delivery slot sent with a move to `delivery_scheduled`. */
export interface DeliverySlotInput {
  /** YYYY-MM-DD, Israel time, not before today. */
  date: string;
  /** HH:MM, 24 hours; `windowFrom` < `windowTo`. */
  windowFrom: string;
  windowTo: string;
  note?: string;
}

/** POST /api/admin/orders/:number/status (permission orders.manage). */
export interface AdvanceOrderRequest {
  to: OrderStatus;
  /** Required when `to` is `delivery_scheduled`. */
  slot?: DeliverySlotInput;
}

/** GET /api/admin/providers */
export interface ProvidersStatus {
  payment: { code: string; testMode: boolean };
  shipping: { code: string };
}
