import type { AdminShippingRatesInput } from '@hg/models';
import { parseRatesInput, parseZoneInput } from './shipping-admin-input.js';

const SETTINGS = { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 };
const valid = (patch: Partial<AdminShippingRatesInput> = {}): AdminShippingRatesInput => ({
  rates: [
    { categoryId: null, deliveryPrice: 15_000, assemblyPrice: 0 },
    { categoryId: 3, deliveryPrice: 40_000, assemblyPrice: 30_000 },
    { categoryId: 4, deliveryPrice: null, assemblyPrice: null },
  ],
  settings: SETTINGS,
  ...patch,
});

/** The `field` of the 400 a body is refused with. */
function refusedField(parse: () => unknown): string | undefined {
  try {
    parse();
  } catch (e) {
    const body = (e as { getResponse(): { code: string; field?: string } }).getResponse();
    expect(body.code).toBe('invalid');
    return body.field;
  }
  throw new Error('expected the body to be refused');
}

describe('parseRatesInput', () => {
  it('accepts the whole price list with the default row', () => {
    expect(parseRatesInput(valid())).toEqual(valid());
  });

  it('needs the default row, with both prices', () => {
    expect(refusedField(() => parseRatesInput(valid({ rates: [] })))).toBe('rates');
    expect(
      refusedField(() =>
        parseRatesInput(valid({ rates: [{ categoryId: null, deliveryPrice: null, assemblyPrice: null }] })),
      ),
    ).toBe('rates.0.deliveryPrice');
  });

  it('refuses negative, fractional and non-number prices', () => {
    for (const bad of [-1, 1.5, '100', Number.NaN]) {
      const rates = [{ categoryId: null, deliveryPrice: bad as number, assemblyPrice: 0 }];
      expect(refusedField(() => parseRatesInput(valid({ rates })))).toBe('rates.0.deliveryPrice');
    }
  });

  it('needs both prices of a category row, or neither', () => {
    const rates = [...valid().rates, { categoryId: 5, deliveryPrice: 100, assemblyPrice: null }];
    expect(refusedField(() => parseRatesInput(valid({ rates })))).toBe('rates.3.assemblyPrice');
  });

  it('refuses the same category twice', () => {
    const rates = [...valid().rates, { categoryId: 3, deliveryPrice: 1, assemblyPrice: 1 }];
    expect(refusedField(() => parseRatesInput(valid({ rates })))).toBe('rates.3.categoryId');
  });

  it('checks the settings ranges', () => {
    const settings = (patch: object) => valid({ settings: { ...SETTINGS, ...patch } });
    expect(parseRatesInput(settings({ additionalItemPercent: 0, floorSurchargeFrom: 1 })).settings).toMatchObject({
      additionalItemPercent: 0,
      floorSurchargeFrom: 1,
    });
    expect(parseRatesInput(settings({ additionalItemPercent: 100, floorSurchargeFrom: 60 }))).toBeTruthy();
    expect(refusedField(() => parseRatesInput(settings({ additionalItemPercent: 101 })))).toBe('additionalItemPercent');
    expect(refusedField(() => parseRatesInput(settings({ additionalItemPercent: -1 })))).toBe('additionalItemPercent');
    expect(refusedField(() => parseRatesInput(settings({ floorSurcharge: -100 })))).toBe('floorSurcharge');
    expect(refusedField(() => parseRatesInput(settings({ floorSurchargeFrom: 0 })))).toBe('floorSurchargeFrom');
    expect(refusedField(() => parseRatesInput(settings({ floorSurchargeFrom: 61 })))).toBe('floorSurchargeFrom');
    expect(refusedField(() => parseRatesInput(settings({ floorSurchargeFrom: 2.5 })))).toBe('floorSurchargeFrom');
  });
});

describe('parseZoneInput', () => {
  it('trims the name and keeps the localities', () => {
    expect(parseZoneInput({ name: '  אילת  ', surcharge: 25_000, localityIds: [2600, 7] })).toEqual({
      name: 'אילת',
      surcharge: 25_000,
      localityIds: [2600, 7],
    });
  });

  it('refuses an empty name, a bad surcharge and bad or repeated localities', () => {
    expect(refusedField(() => parseZoneInput({ name: ' ', surcharge: 0, localityIds: [] }))).toBe('name');
    expect(refusedField(() => parseZoneInput({ name: 'א', surcharge: -5, localityIds: [] }))).toBe('surcharge');
    expect(refusedField(() => parseZoneInput({ name: 'א', surcharge: 0, localityIds: [0] }))).toBe('localityIds');
    expect(refusedField(() => parseZoneInput({ name: 'א', surcharge: 0, localityIds: [7, 7] }))).toBe('localityIds');
    expect(refusedField(() => parseZoneInput({ name: 'א', surcharge: 0 }))).toBe('localityIds');
  });
});
