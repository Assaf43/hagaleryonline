import { OrderStatus } from '../generated/prisma/client.js';
import { canAdvance, canCancel, nextStatuses, PAID_OR_LATER } from './order-transitions.js';

const S = OrderStatus;

describe('order transitions (spec §4.1)', () => {
  it('moves forward along the flow, skipping allowed', () => {
    expect(canAdvance(S.PAID, S.PROCESSING)).toBe(true);
    expect(canAdvance(S.PROCESSING, S.SHIPPED)).toBe(true);
    expect(canAdvance(S.PAID, S.DELIVERED)).toBe(true);
  });

  it('PAID_OR_LATER is paid and every step after it, nothing else', () => {
    expect(PAID_OR_LATER).toEqual(new Set([S.PAID, S.PROCESSING, S.DELIVERY_SCHEDULED, S.SHIPPED, S.DELIVERED]));
  });

  it('never goes backward or stays', () => {
    expect(canAdvance(S.SHIPPED, S.PROCESSING)).toBe(false);
    expect(canAdvance(S.PAID, S.PAID)).toBe(false);
  });

  it('treats delivered as final and refuses states outside the flow', () => {
    for (const to of Object.values(S)) expect(canAdvance(S.DELIVERED, to)).toBe(false);
    expect(canAdvance(S.PENDING_PAYMENT, S.PROCESSING)).toBe(false);
    expect(canAdvance(S.CANCELLED, S.PROCESSING)).toBe(false);
    expect(canAdvance(S.PAID, S.CANCELLED)).toBe(false);
  });

  it('lets the customer cancel only an unpaid order', () => {
    expect(canCancel(S.PENDING_PAYMENT, 'customer')).toBe(true);
    expect(canCancel(S.PAID, 'customer')).toBe(false);
  });

  it('lets staff cancel until shipped is done, never after delivery', () => {
    for (const from of [S.PENDING_PAYMENT, S.PAID, S.PROCESSING, S.DELIVERY_SCHEDULED, S.SHIPPED])
      expect(canCancel(from, 'admin')).toBe(true);
    for (const from of [S.DELIVERED, S.CANCELLED, S.EXPIRED, S.PAYMENT_FAILED])
      expect(canCancel(from, 'admin')).toBe(false);
  });

  it('lists the next statuses', () => {
    expect(nextStatuses(S.PAID)).toEqual([S.PROCESSING, S.DELIVERY_SCHEDULED, S.SHIPPED, S.DELIVERED]);
    expect(nextStatuses(S.SHIPPED)).toEqual([S.DELIVERED]);
    expect(nextStatuses(S.DELIVERED)).toEqual([]);
    expect(nextStatuses(S.EXPIRED)).toEqual([]);
  });
});
