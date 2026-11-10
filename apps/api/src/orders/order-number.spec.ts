import {
  FIRST_ORDER_NUMBER,
  formatOrderNumber,
  parseOrderNumber,
  RESERVATION_MS,
  reservedUntil,
} from './order-number.js';

describe('order numbers (spec §5.2)', () => {
  it('the sequence starts at 100001', () => {
    expect(FIRST_ORDER_NUMBER).toBe(100_001);
  });

  it('formats as plain digits (no separators, safe in a URL)', () => {
    expect(formatOrderNumber(100_001)).toBe('100001');
    expect(formatOrderNumber(1_234_567)).toBe('1234567');
  });

  it('parses the URL segment back, refusing anything that cannot be an order number', () => {
    expect(parseOrderNumber('100001')).toBe(100_001);
    expect(parseOrderNumber('2345678')).toBe(2_345_678);
    for (const bad of ['', '100000', '99999', '0', '-100001', '100001a', '1e6', '100001.0', ' 100001', '9'.repeat(20)])
      expect(parseOrderNumber(bad)).toBeNull();
  });

  it('holds stock for 20 minutes (decision 69)', () => {
    expect(RESERVATION_MS).toBe(20 * 60_000);
    expect(reservedUntil(new Date('2026-11-10T10:00:00Z')).toISOString()).toBe('2026-11-10T10:20:00.000Z');
  });
});
