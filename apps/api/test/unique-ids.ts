/**
 * Unique 8-digit ids for e2e phones and e-mails. Every e2e file that makes customers passes its own `fileDigit`, so
 * values never collide across files sharing the `_test` database (a leftover of another file, or a parallel helper):
 * the digit, then a per-file sequence (4 digits), then the clock's milliseconds (3 digits) against leftovers of an
 * earlier run of the same file. Phones are `05` + this (10 digits).
 *
 * Digits in use: 1 account, 2 customer-auth, 3 customer-unverified-email, 4 promotions, 5 store-customer,
 * 6 store-orders, 7 marketing-consent, 8 member-pricing.
 */
export function uniqueIds(fileDigit: number): () => string {
  if (!Number.isInteger(fileDigit) || fileDigit < 0 || fileDigit > 9) throw new Error('fileDigit must be 0-9');
  let seq = 0;
  return () =>
    String(fileDigit) + String(++seq % 10_000).padStart(4, '0') + String(Date.now() % 1_000).padStart(3, '0');
}
