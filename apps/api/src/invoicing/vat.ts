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

/** The VAT inside a gross (VAT-included) amount in agorot, rounded to whole agorot: round(gross − gross / (1 + rate)). */
export function vatOf(grossAgorot: number, rate: number): number {
  return Math.round(grossAgorot - grossAgorot / (1 + rate));
}
