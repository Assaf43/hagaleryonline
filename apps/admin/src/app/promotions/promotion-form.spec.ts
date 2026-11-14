import type { AdminPromotion } from '@hg/models';
import { emptyForm, promotionInput, serverFieldOf, toForm, type PromotionForm } from './promotion-form';
import { endFields, formatIsraelDate, israelDay, israelEndToUtc, israelStartToUtc, startFields } from './israel-time';

const COUPON: AdminPromotion = {
  id: 4,
  name: 'קופון חורף',
  kind: 'coupon',
  code: 'WINTER',
  discountType: 'fixed',
  value: 25_000,
  target: 'products',
  targets: [{ id: 9, nameHe: 'ספה תלת', modelName: 'ALBA', active: true, thumbnailUrl: null }],
  minSubtotal: 300_000,
  // 1.12.2026 00:00 – 31.12.2026 end of day, Israel winter time (UTC+2).
  startsAt: '2026-11-30T22:00:00.000Z',
  endsAt: '2026-12-31T21:59:59.999Z',
  usageLimit: 100,
  usedCount: 7,
  isWelcome: false,
  active: true,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

const valid = (patch: Partial<PromotionForm> = {}): PromotionForm => ({
  ...emptyForm(),
  name: 'מבצע סוף עונה',
  kind: 'coupon',
  code: 'sale10',
  value: '10',
  ...patch,
});

describe('Israel time (promotion dates)', () => {
  it('a date-only start is 00:00 and a date-only end is 23:59:59.999 in Israel, around the spring DST change', () => {
    // Israel moves to summer time (UTC+3) on Friday 27.3.2026 at 02:00.
    expect(israelStartToUtc('2026-03-27', '')).toBe('2026-03-26T22:00:00.000Z');
    expect(israelEndToUtc('2026-03-27', '')).toBe('2026-03-27T20:59:59.999Z');
    expect(israelStartToUtc('2026-03-26', '')).toBe('2026-03-25T22:00:00.000Z');
    expect(israelEndToUtc('2026-03-28', '')).toBe('2026-03-28T20:59:59.999Z');
  });

  it('handles the autumn DST change and explicit times', () => {
    // Back to winter time (UTC+2) on Sunday 25.10.2026 at 02:00.
    expect(israelStartToUtc('2026-10-25', '')).toBe('2026-10-24T21:00:00.000Z');
    expect(israelEndToUtc('2026-10-25', '')).toBe('2026-10-25T21:59:59.999Z');
    expect(israelStartToUtc('2026-10-25', '09:30')).toBe('2026-10-25T07:30:00.000Z');
    expect(israelEndToUtc('2026-07-01', '18:00')).toBe('2026-07-01T15:00:00.000Z');
  });

  it('shows stored times back in Israel time, without a time at the day edges', () => {
    expect(startFields('2026-03-26T22:00:00.000Z')).toEqual({ date: '2026-03-27', time: '' });
    expect(endFields('2026-03-27T20:59:59.999Z')).toEqual({ date: '2026-03-27', time: '' });
    expect(startFields('2026-10-25T07:30:00.000Z')).toEqual({ date: '2026-10-25', time: '09:30' });
    expect(endFields('2026-07-01T15:00:00.000Z')).toEqual({ date: '2026-07-01', time: '18:00' });
    expect(startFields(null)).toEqual({ date: '', time: '' });
    expect(formatIsraelDate('2026-12-31T21:59:59.999Z', 'end')).toBe('31.12.2026');
    expect(formatIsraelDate('2026-07-01T15:00:00.000Z', 'end')).toBe('1.7.2026 18:00');
    // Late evening UTC is already the next Israel day, whatever the machine's own time zone.
    expect(israelDay('2026-11-05T22:30:00.000Z')).toBe('6.11.2026');
    expect(israelDay('2026-07-01T20:59:00.000Z')).toBe('1.7.2026');
    expect(israelDay('2026-07-01T21:00:00.000Z')).toBe('2.7.2026');
    expect(formatIsraelDate('2026-11-30T22:00:00.000Z', 'start')).toBe('1.12.2026');
  });
});

describe('promotion form', () => {
  it('reads a saved promotion: agorot as shekels, dates in Israel time', () => {
    const form = toForm(COUPON);
    expect(form).toMatchObject({
      name: 'קופון חורף',
      kind: 'coupon',
      code: 'WINTER',
      discountType: 'fixed',
      value: '250',
      target: 'products',
      minSubtotal: '3000',
      startDate: '2026-12-01',
      startTime: '',
      endDate: '2026-12-31',
      endTime: '',
      usageLimit: '100',
      active: true,
    });
    expect(form.products.map((p) => p.modelName)).toEqual(['ALBA']);
  });

  it('builds the input in agorot with UTC dates and a normalized code', () => {
    const { input, errors } = promotionInput(toForm(COUPON));
    expect(errors).toEqual({});
    expect(input).toEqual({
      name: 'קופון חורף',
      kind: 'coupon',
      code: 'WINTER',
      discountType: 'fixed',
      value: 25_000,
      target: 'products',
      targetIds: [9],
      minSubtotal: 300_000,
      startsAt: '2026-11-30T22:00:00.000Z',
      endsAt: '2026-12-31T21:59:59.999Z',
      usageLimit: 100,
      active: true,
      isWelcome: false,
    });
    expect(promotionInput(valid({ code: ' sale‏10 ' })).input?.code).toBe('SALE10');
    // Whole shekels: "150" and "150.00" are fine.
    expect(promotionInput(valid({ value: '150', discountType: 'fixed' })).input?.value).toBe(15_000);
    expect(
      promotionInput(valid({ value: '150.00', discountType: 'fixed', minSubtotal: '1000.0' })).input,
    ).toMatchObject({
      value: 15_000,
      minSubtotal: 100_000,
    });
    // Empty minimum = none; empty limit = no limit.
    expect(promotionInput(valid({ minSubtotal: '', usageLimit: '' })).input).toMatchObject({
      minSubtotal: 0,
      usageLimit: null,
    });
  });

  it('the welcome benefit: read from the promotion, sent only for an automatic one (decision 79)', () => {
    expect(emptyForm().isWelcome).toBe(false);
    expect(toForm({ ...COUPON, kind: 'automatic', code: null, isWelcome: true }).isWelcome).toBe(true);
    expect(promotionInput(valid({ kind: 'automatic', isWelcome: true })).input).toMatchObject({
      kind: 'automatic',
      isWelcome: true,
    });
    // A coupon is never a welcome benefit, whatever the hidden box says.
    expect(promotionInput(valid({ kind: 'coupon', isWelcome: true })).input?.isWelcome).toBe(false);
  });

  it('automatic promotions have no code and no usage limit', () => {
    const { input } = promotionInput(valid({ kind: 'automatic', code: 'IGNORED', usageLimit: '5' }));
    expect(input).toMatchObject({ kind: 'automatic', code: null, usageLimit: null });
  });

  it('checks every field and says what is wrong, in the order of the form', () => {
    const errors = promotionInput(
      valid({
        name: ' ',
        code: 'SAVE 10',
        value: '101',
        target: 'categories',
        categoryIds: [],
        minSubtotal: '-1',
        startTime: '10:00',
        usageLimit: '0',
      }),
    ).errors;
    expect(Object.keys(errors)).toEqual([
      'name',
      'code',
      'value',
      'targetIds',
      'minSubtotal',
      'startDate',
      'usageLimit',
    ]);
    expect(errors.name).toBe('חובה לתת שם למבצע');
    expect(errors.value).toBe('מספר שלם בין 1 ל-100');
    expect(errors.targetIds).toBe('צריך לבחור לפחות קטגוריה אחת');

    expect(promotionInput(valid({ code: '' })).errors.code).toBe('חובה למלא קוד קופון');
    expect(promotionInput(valid({ value: '12.5' })).errors.value).toBe('מספר שלם בין 1 ל-100');
    expect(promotionInput(valid({ value: '0' })).errors.value).toBe('מספר שלם בין 1 ל-100');
    for (const bad of ['0', '-5', 'abc', '1.234', '150.50', '99.99'])
      expect(promotionInput(valid({ discountType: 'fixed', value: bad })).errors.value).toBe(
        'סכום בשקלים שלמים, גדול מ-0',
      );
    for (const bad of ['-1', '1000.5', 'abc'])
      expect(promotionInput(valid({ minSubtotal: bad })).errors.minSubtotal).toBe('סכום בשקלים שלמים, 0 ומעלה');
    // Dates between 2000 and 2100 only.
    expect(promotionInput(valid({ startDate: '1999-12-31' })).errors.startDate).toBe('תאריך בין 2000 ל-2100');
    expect(promotionInput(valid({ endDate: '2101-01-01' })).errors.endDate).toBe('תאריך בין 2000 ל-2100');
    expect(promotionInput(valid({ endDate: '2100-12-31' })).errors).toEqual({});
    expect(promotionInput(valid({ target: 'products', products: [] })).errors.targetIds).toBe(
      'צריך לבחור לפחות מוצר אחד',
    );
    expect(promotionInput(valid({ startDate: '2026-12-10', endDate: '2026-12-01' })).errors.endDate).toBe(
      'הסיום צריך להיות אחרי ההתחלה',
    );
    // The same day is fine: from its start to its end.
    expect(promotionInput(valid({ startDate: '2026-12-10', endDate: '2026-12-10' })).errors).toEqual({});
  });

  it('maps the API field of a refusal to the form field', () => {
    expect(serverFieldOf('startsAt')).toBe('startDate');
    expect(serverFieldOf('endsAt')).toBe('endDate');
    expect(serverFieldOf('code')).toBe('code');
    expect(serverFieldOf('targetIds')).toBe('targetIds');
    expect(serverFieldOf('active')).toBeNull();
  });
});
