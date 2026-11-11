import { HttpException, HttpStatus } from '@nestjs/common';
import type { CheckoutErrorCode } from '@hg/models';

/** Errors of checkout, orders and payments: `{ statusCode, code, ...details }` (models `CheckoutErrorCode`). */
export class CheckoutError extends HttpException {
  constructor(status: HttpStatus, code: CheckoutErrorCode, extra: Record<string, unknown> = {}) {
    super({ statusCode: status, code, ...extra }, status);
  }
}

export const fieldError = (field: string, messageHe: string) =>
  new CheckoutError(HttpStatus.BAD_REQUEST, 'invalid_field', { field, messageHe });
/** A line asks for more than can be sold now; `available` is its new limit. */
export const shortage = (variantId: number, available: number) =>
  new CheckoutError(HttpStatus.CONFLICT, 'insufficient_stock', { variantId, available });
export const emptyCart = () => new CheckoutError(HttpStatus.CONFLICT, 'empty_cart');
export const cartChanged = () => new CheckoutError(HttpStatus.CONFLICT, 'cart_changed');
/** The recomputed total differs from the one the customer saw; `total` is the new one (agorot). */
export const priceChanged = (total: number) => new CheckoutError(HttpStatus.CONFLICT, 'price_changed', { total });
/** The cart's coupon was used up since the customer saw it (spec §6): remove it and try again. */
export const couponInvalid = (messageHe: string) =>
  new CheckoutError(HttpStatus.CONFLICT, 'coupon_invalid', { field: 'coupon', messageHe });
export const shippingUnavailable = () => new CheckoutError(HttpStatus.SERVICE_UNAVAILABLE, 'shipping_unavailable');
export const paymentUnavailable = () => new CheckoutError(HttpStatus.BAD_GATEWAY, 'payment_unavailable');
export const notRetryable = () => new CheckoutError(HttpStatus.CONFLICT, 'not_retryable');
/** A newer order of the same cart replaced this one. */
export const superseded = () => new CheckoutError(HttpStatus.CONFLICT, 'superseded');
export const orderNotFound = () => new CheckoutError(HttpStatus.NOT_FOUND, 'not_found');
export const invalidInput = () => new CheckoutError(HttpStatus.BAD_REQUEST, 'invalid_input');
