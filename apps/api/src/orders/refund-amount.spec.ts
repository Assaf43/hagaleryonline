import { refundable } from './refund-amount.js';

describe('refundable (spec §4.3, decision 74)', () => {
  it('is paid minus refunded', () => {
    expect(refundable(100_000, 30_000, 0)).toBe(70_000);
    expect(refundable(100_000, 0, 0)).toBe(100_000);
  });

  it('counts pending refunds against it', () => {
    expect(refundable(100_000, 30_000, 20_000)).toBe(50_000);
    expect(refundable(100_000, 0, 100_000)).toBe(0);
  });

  it('never goes below zero', () => {
    expect(refundable(100_000, 100_000, 0)).toBe(0);
    expect(refundable(0, 0, 0)).toBe(0);
    expect(refundable(100_000, 90_000, 50_000)).toBe(0);
  });
});
