import { israelDate, vatOf, vatRateOn } from './vat.js';

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const RATES = [
  { rate: 0.17, effectiveFrom: day('2015-10-01') },
  { rate: 0.18, effectiveFrom: day('2025-01-01') },
];

describe('vatOf', () => {
  it('takes the VAT out of a gross amount: 11800 at 18% → 1800', () => {
    expect(vatOf(11800, 0.18)).toBe(1800);
  });

  it('rounds to whole agorot', () => {
    // 100 − 100 / 1.18 = 15.25…
    expect(vatOf(100, 0.18)).toBe(15);
    // 345000 − 345000 / 1.18 = 52627.1…
    expect(vatOf(345000, 0.18)).toBe(52627);
    expect(vatOf(0, 0.18)).toBe(0);
  });

  it('keeps the sign of a negative amount (a discount line)', () => {
    expect(vatOf(-11800, 0.18)).toBe(-1800);
  });
});

describe('vatRateOn', () => {
  it('picks the latest rate whose effectiveFrom is on or before the date', () => {
    expect(vatRateOn(RATES, new Date('2026-11-12T10:00:00Z'))).toBe(0.18);
    expect(vatRateOn(RATES, new Date('2024-12-31T12:00:00Z'))).toBe(0.17);
    // Order of the table does not matter.
    expect(vatRateOn([...RATES].reverse(), new Date('2026-11-12T10:00:00Z'))).toBe(0.18);
  });

  it('uses the Israel calendar date: 31.12.2024 23:30 UTC is already 1.1.2025 in Israel', () => {
    expect(vatRateOn(RATES, new Date('2024-12-31T23:30:00Z'))).toBe(0.18);
    expect(vatRateOn(RATES, new Date('2024-12-31T21:59:00Z'))).toBe(0.17);
  });

  it('the first day of a rate counts', () => {
    expect(vatRateOn(RATES, new Date('2025-01-01T00:00:00+02:00'))).toBe(0.18);
  });

  it('throws when no rate is in force on the date', () => {
    expect(() => vatRateOn(RATES, new Date('2010-01-01T12:00:00Z'))).toThrow(/VAT rate/);
    expect(() => vatRateOn([], new Date())).toThrow(/VAT rate/);
  });
});

describe('israelDate', () => {
  it('is the calendar date in Israel as YYYY-MM-DD', () => {
    expect(israelDate(new Date('2026-11-12T22:30:00Z'))).toBe('2026-11-13');
    expect(israelDate(new Date('2026-07-01T20:59:00Z'))).toBe('2026-07-01');
  });
});
