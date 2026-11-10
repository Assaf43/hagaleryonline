import type { ShippingOption } from '@hg/models';
import { quoteShipping, shippingFrom, shippingUnits, type ShippingPriceSettings } from './shipping-rules.js';

const SETTINGS: ShippingPriceSettings = { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 };
const GROUND = { floor: 0, hasElevator: false, zoneSurcharge: 0 };
const unit = (deliveryPrice: number, assemblyPrice = 0) => ({ deliveryPrice, assemblyPrice });
const method = (options: ShippingOption[], m: ShippingOption['method']) => options.find((o) => o.method === m)!;

describe('quoteShipping (spec §4.1, SHP-01–03)', () => {
  it('quotes one item in both methods', () => {
    const options = quoteShipping([unit(30_000, 20_000)], SETTINGS, GROUND);
    expect(options.map((o) => o.method)).toEqual(['curbside', 'full_service']);
    expect(method(options, 'curbside')).toEqual({
      method: 'curbside',
      total: 30_000,
      lines: [{ labelHe: 'הובלה', amount: 30_000 }],
    });
    expect(method(options, 'full_service')).toEqual({
      method: 'full_service',
      total: 50_000,
      lines: [
        { labelHe: 'הובלה', amount: 30_000 },
        { labelHe: 'הרכבה', amount: 20_000 },
      ],
    });
  });

  it('charges the most expensive unit in full and every other unit at the percent', () => {
    const options = quoteShipping([unit(10_000), unit(30_000), unit(20_000)], SETTINGS, GROUND);
    expect(method(options, 'curbside')).toEqual({
      method: 'curbside',
      total: 30_000 + 10_000 + 5_000,
      lines: [
        { labelHe: 'הובלה', amount: 60_000 },
        { labelHe: 'הנחה על פריטים נוספים', amount: -15_000 },
      ],
    });
  });

  it('charges every unit in full at 100%, and only the first at 0%', () => {
    const units = [unit(10_000), unit(30_000), unit(20_000)];
    expect(method(quoteShipping(units, { ...SETTINGS, additionalItemPercent: 100 }, GROUND), 'curbside')).toEqual({
      method: 'curbside',
      total: 60_000,
      lines: [{ labelHe: 'הובלה', amount: 60_000 }],
    });
    expect(method(quoteShipping(units, { ...SETTINGS, additionalItemPercent: 0 }, GROUND), 'curbside').total).toBe(
      30_000,
    );
  });

  it('rounds the reduced delivery price to whole agorot', () => {
    expect(
      method(quoteShipping([unit(10_000), unit(333)], { ...SETTINGS, additionalItemPercent: 50 }, GROUND), 'curbside')
        .total,
    ).toBe(10_000 + 167);
  });

  it('charges assembly in full per unit', () => {
    const full = method(quoteShipping([unit(30_000, 20_000), unit(10_000, 5_000)], SETTINGS, GROUND), 'full_service');
    expect(full.lines).toContainEqual({ labelHe: 'הרכבה', amount: 25_000 });
    expect(full.total).toBe(30_000 + 5_000 + 25_000);
  });

  it('adds no floor surcharge below the starting floor', () => {
    const full = method(quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, floor: 1 }), 'full_service');
    expect(full.total).toBe(30_000);
    expect(full.lines.map((l) => l.labelHe)).not.toContain('תוספת קומה ללא מעלית');
  });

  it('adds one floor surcharge at the starting floor without an elevator', () => {
    const full = method(quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, floor: 2 }), 'full_service');
    expect(full.lines).toContainEqual({ labelHe: 'תוספת קומה ללא מעלית', amount: 5_000 });
    expect(full.total).toBe(35_000);
  });

  it('adds four floor surcharges on floor 5 from floor 2', () => {
    const full = method(quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, floor: 5 }), 'full_service');
    expect(full.lines).toContainEqual({ labelHe: 'תוספת קומה ללא מעלית', amount: 20_000 });
    expect(full.total).toBe(50_000);
  });

  it('adds no floor surcharge with an elevator', () => {
    const full = method(
      quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, floor: 5, hasElevator: true }),
      'full_service',
    );
    expect(full.total).toBe(30_000);
  });

  it('never adds a floor surcharge to curbside', () => {
    const curbside = method(quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, floor: 9 }), 'curbside');
    expect(curbside).toEqual({ method: 'curbside', total: 30_000, lines: [{ labelHe: 'הובלה', amount: 30_000 }] });
  });

  it('adds the zone surcharge once, to both methods', () => {
    const options = quoteShipping([unit(30_000, 20_000), unit(10_000)], SETTINGS, {
      ...GROUND,
      zoneSurcharge: 25_000,
      zoneName: 'אילת והערבה',
    });
    const zoneLine = { labelHe: 'תוספת אזור: אילת והערבה', amount: 25_000 };
    expect(method(options, 'curbside').lines).toContainEqual(zoneLine);
    expect(method(options, 'curbside').total).toBe(30_000 + 5_000 + 25_000);
    expect(method(options, 'full_service').lines.filter((l) => l.labelHe === zoneLine.labelHe)).toEqual([zoneLine]);
    expect(method(options, 'full_service').total).toBe(30_000 + 5_000 + 20_000 + 25_000);
  });

  it('labels the zone line without a colon when the zone has no name', () => {
    const options = quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, zoneSurcharge: 5_000 });
    expect(method(options, 'curbside').lines).toContainEqual({ labelHe: 'תוספת אזור', amount: 5_000 });
    const named = quoteShipping([unit(30_000)], SETTINGS, { ...GROUND, zoneSurcharge: 5_000, zoneName: '  ' });
    expect(method(named, 'curbside').lines).toContainEqual({ labelHe: 'תוספת אזור', amount: 5_000 });
  });

  it('totals always equal the sum of the lines', () => {
    const options = quoteShipping([unit(30_000, 20_000), unit(12_345, 999), unit(7_777, 1)], SETTINGS, {
      floor: 4,
      hasElevator: false,
      zoneSurcharge: 1_234,
      zoneName: 'אזור',
    });
    for (const o of options) expect(o.total).toBe(o.lines.reduce((sum, l) => sum + l.amount, 0));
  });
});

describe('shippingFrom (CRT-05)', () => {
  it('is the curbside total without zone or floor surcharges', () => {
    expect(shippingFrom([unit(10_000, 9_000), unit(30_000, 9_000)], SETTINGS)).toBe(35_000);
  });
});

describe('shippingUnits', () => {
  const rates = [
    { categoryId: null, deliveryPrice: 15_000, assemblyPrice: 0 },
    { categoryId: 1, deliveryPrice: 30_000, assemblyPrice: 20_000 },
  ];

  it("uses the top-level category's rate", () => {
    expect(shippingUnits([{ topCategoryId: 1, quantity: 1 }], rates)).toEqual([unit(30_000, 20_000)]);
  });

  it('uses the default row for a category without a rate', () => {
    expect(shippingUnits([{ topCategoryId: 7, quantity: 1 }], rates)).toEqual([unit(15_000, 0)]);
  });

  it('counts quantity 2 of one variant as two units', () => {
    const units = shippingUnits([{ topCategoryId: 1, quantity: 2 }], rates);
    expect(units).toEqual([unit(30_000, 20_000), unit(30_000, 20_000)]);
    expect(method(quoteShipping(units, SETTINGS, GROUND), 'curbside').total).toBe(30_000 + 15_000);
  });

  it('prices a category without a rate at 0 when there is no default row either', () => {
    expect(shippingUnits([{ topCategoryId: 7, quantity: 1 }], [rates[1]])).toEqual([unit(0, 0)]);
  });
});
