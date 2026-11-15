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
export function confirmationPath(number: number, token: string): string {
  return `/order/${formatOrderNumber(number)}?t=${encodeURIComponent(token)}`;
}

/** Where the payment provider returns a store order paid on the store tablet: a page without personal data (§4.7). */
export const STORE_RETURN_PATH = '/pay/done';

/**
 * Where the payment provider returns the customer after paying (`OrderSummary.returnPath`): the tokened confirmation
 * page for a website order; never that link for a store order, whose tablet is shared — its link comes by e-mail.
 */
export function returnPathOf(order: { number: number; publicToken: string; channel: 'WEB' | 'STORE' }): string {
  return order.channel === 'STORE' ? STORE_RETURN_PATH : confirmationPath(order.number, order.publicToken);
}
