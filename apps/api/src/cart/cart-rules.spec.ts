import { clampQuantity, deliveryEstimate, lineLimit } from './cart-rules.js';
import { MAX_MADE_TO_ORDER } from './available-stock.js';

describe('lineLimit (CRT-02)', () => {
  it('limits in-stock variants to the available stock', () => {
    expect(lineLimit('in_stock', 3)).toBe(3);
    expect(lineLimit('in_stock', 0)).toBe(0);
    expect(lineLimit('in_stock', -2)).toBe(0);
  });

  it('limits made-to-order and pre-order variants to 10, whatever the stock', () => {
    expect(MAX_MADE_TO_ORDER).toBe(10);
    expect(lineLimit('made_to_order', 0)).toBe(10);
    expect(lineLimit('pre_order', 50)).toBe(10);
  });

  it('gives out-of-stock variants no quantity', () => {
    expect(lineLimit('out_of_stock', 7)).toBe(0);
  });
});

describe('clampQuantity', () => {
  it('keeps a quantity inside the limit', () => {
    expect(clampQuantity(2, 5)).toBe(2);
    expect(clampQuantity(5, 5)).toBe(5);
  });

  it('clamps above the limit', () => {
    expect(clampQuantity(8, 3)).toBe(3);
  });

  it('clamps below 1 to 1 when the limit allows one', () => {
    expect(clampQuantity(0, 3)).toBe(1);
    expect(clampQuantity(-4, 1)).toBe(1);
  });

  it('returns 0 when nothing can be ordered', () => {
    expect(clampQuantity(2, 0)).toBe(0);
  });
});

describe('deliveryEstimate (CRT-04)', () => {
  const line = (fulfillment: 'in_stock' | 'pre_order' | 'made_to_order', leadTimeDays: number, available = true) => ({
    fulfillment,
    leadTimeDays,
    available,
  });

  it('picks the longest lead time', () => {
    expect(deliveryEstimate([line('in_stock', 7), line('made_to_order', 45), line('pre_order', 30)])).toEqual({
      fulfillment: 'made_to_order',
      leadTimeDays: 45,
    });
  });

  it('ignores unavailable lines', () => {
    expect(deliveryEstimate([line('in_stock', 7), line('made_to_order', 60, false)])).toEqual({
      fulfillment: 'in_stock',
      leadTimeDays: 7,
    });
  });

  it('takes the slower fulfillment mode on a tie', () => {
    expect(deliveryEstimate([line('made_to_order', 30), line('in_stock', 30), line('pre_order', 30)])).toEqual({
      fulfillment: 'made_to_order',
      leadTimeDays: 30,
    });
    expect(deliveryEstimate([line('pre_order', 14), line('in_stock', 14)])).toEqual({
      fulfillment: 'pre_order',
      leadTimeDays: 14,
    });
  });

  it('returns null without available lines', () => {
    expect(deliveryEstimate([])).toBeNull();
    expect(deliveryEstimate([line('in_stock', 7, false)])).toBeNull();
  });
});
