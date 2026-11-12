/** One row of the VAT rate table (`vat_rates`): `rate` is a fraction (0.18), `effectiveFrom` a calendar date. */
export interface VatRateRow {
  rate: number;
  /** A `@db.Date` column: midnight UTC of the calendar date. */
  effectiveFrom: Date;
}

const ISRAEL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' });

/** The calendar date in Israel of an instant, as YYYY-MM-DD. */
export function israelDate(at: Date): string {
  return ISRAEL_DAY.format(at);
}

/**
 * The VAT rate in force on the Israel calendar date of `at` (spec §5.4): the latest row whose `effectiveFrom` is on
 * or before that date. Throws when none is — a tax document must never be issued with a guessed rate.
 */
export function vatRateOn(rates: readonly VatRateRow[], at: Date): number {
  const day = israelDate(at);
  let best: VatRateRow | undefined;
  for (const row of rates) {
    const from = row.effectiveFrom.toISOString().slice(0, 10);
    if (from <= day && (!best || from > best.effectiveFrom.toISOString().slice(0, 10))) best = row;
  }
  if (!best) throw new Error(`No VAT rate in force on ${day}`);
  return best.rate;
}

/**
 * A tax document's amounts, checked before the provider is called: a whole positive amount in agorot and a whole VAT
 * with 0 ≤ VAT < amount (the database CHECKs say the same, but by then the provider would already have issued it).
 */
export function assertDocumentAmounts(amount: number, vatAmount: number): void {
  if (!Number.isInteger(amount) || amount <= 0) throw new Error(`Invalid document amount ${amount}: must be > 0`);
  if (!Number.isInteger(vatAmount) || vatAmount < 0 || vatAmount >= amount)
    throw new Error(`Invalid VAT ${vatAmount} for amount ${amount}: must be 0 ≤ VAT < amount`);
}

/** The VAT inside a gross (VAT-included) amount in agorot, rounded to whole agorot: round(gross − gross / (1 + rate)). */
export function vatOf(grossAgorot: number, rate: number): number {
  return Math.round(grossAgorot - grossAgorot / (1 + rate));
}
