/**
 * Cart API contracts (Phase 4a, CRT-02, CRT-04). The cart lives on the server (decision 68) and every
 * price and total is computed there. Money is in agorot (integer, VAT included).
 */
import type { FulfillmentMode, ImageRef } from './catalog.js';

export interface CartLine {
  variantId: number;
  productSlug: string;
  modelName: string;
  nameHe: string;
  /** Hebrew labels of the variant's options in axis order (color, fabric, size, chaise side). */
  optionLabels: string[];
  image: ImageRef | null;
  /**
   * The unit price this cart is charged (agorot): the member price when `atMemberPrice`, else the current regular
   * price. An unavailable line shows its regular price.
   */
  unitPrice: number;
  compareAtPrice: number | null;
  /** The variant's club member price (decision 91), public information; null when it has none. */
  memberPrice: number | null;
  /** `unitPrice` is the member price: the cart is a member's and member pricing won (decision 92). */
  atMemberPrice: boolean;
  quantity: number;
  lineTotal: number;
  /** Most units this line may hold right now (stock for in-stock variants, 10 otherwise). */
  maxQuantity: number;
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
  /** False when the product or variant is no longer shown or cannot be ordered: left out of totals and checkout. */
  available: boolean;
  /** Why an unavailable line cannot be ordered: still shown but nothing left (`sold_out`) or no longer shown (`hidden`); null when available. */
  unavailableReason: CartUnavailableReason | null;
}

export type CartUnavailableReason = 'sold_out' | 'hidden';

export type CartNoticeKind = 'price_changed' | 'quantity_clamped' | 'unavailable' | 'coupon';

export interface CartNotice {
  /** Null for notices about the whole cart (coupons). */
  variantId: number | null;
  kind: CartNoticeKind;
  messageHe: string;
}

/** The one discount of the order (decision 70), from Phase 4d. */
export interface CartDiscount {
  labelHe: string;
  amount: number;
  source: 'automatic' | 'coupon';
  code: string | null;
}

export interface CartView {
  lines: CartLine[];
  /** Units in available lines. */
  itemCount: number;
  /** Sum of available line totals. */
  subtotal: number;
  /** The slowest available line (CRT-04); null when there is none. */
  deliveryEstimate: { fulfillment: FulfillmentMode; leadTimeDays: number } | null;
  notices: CartNotice[];
  /** Lowest delivery price (Phase 4b); null until then. */
  shippingFrom: number | null;
  /** The one discount of the order (Phase 4d): the best automatic promotion or the coupon; null when none applies. */
  discount: CartDiscount | null;
  /**
   * The coupon code entered on this cart (upper-case), applied or not — a coupon that does not apply right now
   * (below its minimum, or beaten by an automatic promotion) stays, with a `coupon` notice; null when none.
   */
  couponCode: string | null;
  /**
   * Which pricing the cart is charged at (decision 92): a member's cart is priced at member prices and at regular
   * prices and the lower total wins (tie → member); a guest cart is always `regular`.
   */
  pricing: CartPricingKind;
  /**
   * Guest hint (spec §9): how much less a club member would pay for the same cart before shipping (agorot); null for a
   * member's cart or when a member would not pay less.
   */
  memberSavings: number | null;
}

/** The pricing a cart or an order was charged at (decision 92). */
export type CartPricingKind = 'regular' | 'member';

export interface AddCartItemRequest {
  variantId: number;
  quantity: number;
}

export interface UpdateCartItemRequest {
  quantity: number;
}

/** Error codes of the cart API (`{ statusCode, code }`). */
export type CartErrorCode = 'invalid_input' | 'not_found' | 'unavailable' | 'invalid_coupon';
