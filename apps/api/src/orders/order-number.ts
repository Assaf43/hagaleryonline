import { ORDER_NUMBER_PATTERN } from '@hg/models';
/** Order numbers come from the `orders_number_seq` sequence, which starts here (migration orders, spec §5.2). */
export const FIRST_ORDER_NUMBER = 100_001;

/** Stock is held this long while the customer pays (decision 69). */
export const RESERVATION_MS = 20 * 60_000;

/** The end of a reservation that starts now. */
export function reservedUntil(now = new Date()): Date {
  return new Date(now.getTime() + RESERVATION_MS);
}

/** As shown to the customer and used in URLs: plain digits. */
export function formatOrderNumber(number: number): string {
  return String(number);
}

/** The largest order number: `orders.number` is a PostgreSQL integer (int4). */
export const MAX_ORDER_NUMBER = 2_147_483_647;

/**
 * The order number of a URL segment, or null when it cannot be one (digits only, from 100001 up to the int4 limit).
 * A larger number would make the database query fail (500) instead of the endpoint's normal 404.
 */
export function parseOrderNumber(value: string): number | null {
  if (!ORDER_NUMBER_PATTERN.test(value)) return null;
  const number = Number(value);
  return number >= FIRST_ORDER_NUMBER && number <= MAX_ORDER_NUMBER ? number : null;
}

/** The confirmation page of an order (storefront, relative). */
export function confirmationPath(order: { number: number; token: string }): string {
  return `/order/${formatOrderNumber(order.number)}?t=${encodeURIComponent(order.token)}`;
}

/** Where the payment provider returns a store order paid on the store tablet: a page without personal data (§4.7). */
// A real provider adapter (Phase 9) must map the provider's success return to `/pay/done?r=ok` and its failure or
// cancel return to `/pay/done?r=fail`: the page shows the outcome only from `r` and never claims a payment otherwise.
export const STORE_RETURN_PATH = '/pay/done';

/**
 * Who opened the payment page, which decides where the provider returns (`OrderSummary.returnPath`):
 *  - `store`: the seller's endpoints (store checkout, store retry) on the shared store tablet → `/pay/done`, a page
 *    without personal data (§4.7); the order's tokened link comes by e-mail;
 *  - `order`: the website's checkout and retry — also a store order retried by its customer from the tokened order
 *    page — → that tokened confirmation page.
 */
export type PaymentReturn = 'store' | 'order';

/** `order.token` is the plain token of the link (`OrderTokens.reveal`). */
export function returnPathFor(order: { number: number; token: string }, returnTo: PaymentReturn): string {
  return returnTo === 'store' ? STORE_RETURN_PATH : confirmationPath(order);
}

/**
 * The fallback when the provider no longer knows the return path it was given (the sandbox after a restart): by the
 * order's channel — a store order never gets the tokened link on what may be the store tablet.
 */
export function defaultReturnPath(order: { number: number; token: string; channel: 'WEB' | 'STORE' }): string {
  return returnPathFor(order, order.channel === 'STORE' ? 'store' : 'order');
}
