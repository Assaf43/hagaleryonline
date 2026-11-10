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

/** The order number of a URL segment, or null when it cannot be one (digits only, from 100001, at most 12 digits). */
export function parseOrderNumber(value: string): number | null {
  if (!/^\d{6,12}$/.test(value)) return null;
  const number = Number(value);
  return number >= FIRST_ORDER_NUMBER ? number : null;
}

/** The confirmation page of an order (storefront, relative). */
export function confirmationPath(number: number, token: string): string {
  return `/order/${formatOrderNumber(number)}?t=${encodeURIComponent(token)}`;
}
