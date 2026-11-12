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

const ISRAEL_WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Jerusalem',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** Israel's offset from UTC at an instant, in ms (+2 h in winter, +3 h in summer). */
function israelOffsetMs(utcMs: number): number {
  const parts = ISRAEL_WALL.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return wall - Math.floor(utcMs / 1000) * 1000;
}

/** The instant of 00:00 in Israel on a calendar date (YYYY-MM-DD); the offset is checked at the result, so DST days come out right. */
export function israelMidnightUtc(date: string): Date {
  const [y, m, d] = date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d);
  const first = asUtc - israelOffsetMs(asUtc);
  return new Date(asUtc - israelOffsetMs(first));
}
