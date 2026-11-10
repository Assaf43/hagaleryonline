import { HttpErrorResponse } from '@angular/common/http';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { AdminShippingConfig } from '@hg/models';
import { ShippingApi } from '../core/shipping.api';
import { parseShekels, ratesInput, rateRows, settingsForm, toShekelText, zoneInput } from './shipping-form';
import { ShippingPage } from './shipping.page';

const CONFIG: AdminShippingConfig = {
  rates: [
    { categoryId: null, categoryNameHe: 'ברירת מחדל', deliveryPrice: 15_000, assemblyPrice: 0 },
    { categoryId: 1, categoryNameHe: 'ספות', deliveryPrice: 40_050, assemblyPrice: 30_000 },
    { categoryId: 2, categoryNameHe: 'כורסאות', deliveryPrice: null, assemblyPrice: null },
  ],
  defaultRateSet: true,
  settings: { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 },
  zones: [{ id: 7, name: 'אילת והערבה', surcharge: 25_000, localities: [{ id: 2600, nameHe: 'אילת' }] }],
};

describe('shipping form', () => {
  it('shows agorot as shekels and reads shekels back as agorot', () => {
    expect(toShekelText(40_050)).toBe('400.5');
    expect(toShekelText(0)).toBe('0');
    expect(toShekelText(null)).toBe('');
    expect(parseShekels('400.5')).toBe(40_050);
    expect(parseShekels(' 150 ')).toBe(15_000);
    expect(parseShekels('0')).toBe(0);
    expect(parseShekels('')).toBeNull();
    for (const bad of ['-1', '1.234', 'abc', '1e3']) expect(parseShekels(bad)).toBeUndefined();
  });

  it('builds the rates input in agorot', () => {
    const { input, errors } = ratesInput(rateRows(CONFIG), settingsForm(CONFIG.settings));
    expect(errors).toEqual({});
    expect(input).toEqual({
      rates: [
        { categoryId: null, deliveryPrice: 15_000, assemblyPrice: 0 },
        { categoryId: 1, deliveryPrice: 40_050, assemblyPrice: 30_000 },
        { categoryId: 2, deliveryPrice: null, assemblyPrice: null },
      ],
      settings: CONFIG.settings,
    });
  });

  it('needs non-negative prices, the default row, and both prices of a category or neither', () => {
    const rows = rateRows(CONFIG);
    rows[0] = { ...rows[0], delivery: '' };
    rows[1] = { ...rows[1], assembly: '-5' };
    rows[2] = { ...rows[2], delivery: '100' };
    const { input, errors } = ratesInput(rows, settingsForm(CONFIG.settings));
    expect(input).toBeNull();
    expect(Object.keys(errors).sort()).toEqual(['rates.0.delivery', 'rates.1.assembly', 'rates.2.assembly']);
  });

  it('checks the settings: percent 0–100, floor 1–60, whole numbers', () => {
    const check = (patch: object) =>
      ratesInput(rateRows(CONFIG), { ...settingsForm(CONFIG.settings), ...patch }).errors;
    expect(check({ additionalItemPercent: '0', floorSurchargeFrom: '60' })).toEqual({});
    expect(check({ additionalItemPercent: '100', floorSurchargeFrom: '1' })).toEqual({});
    expect(Object.keys(check({ additionalItemPercent: '101' }))).toEqual(['additionalItemPercent']);
    expect(Object.keys(check({ additionalItemPercent: '-1' }))).toEqual(['additionalItemPercent']);
    expect(Object.keys(check({ additionalItemPercent: '12.5' }))).toEqual(['additionalItemPercent']);
    expect(Object.keys(check({ floorSurchargeFrom: '0' }))).toEqual(['floorSurchargeFrom']);
    expect(Object.keys(check({ floorSurchargeFrom: '61' }))).toEqual(['floorSurchargeFrom']);
    expect(Object.keys(check({ floorSurcharge: '-10' }))).toEqual(['floorSurcharge']);
  });

  it('needs a zone name and a non-negative surcharge', () => {
    expect(zoneInput({ key: 1, id: null, name: ' צפון ', surcharge: '99.9', localities: [] })).toEqual({
      input: { name: 'צפון', surcharge: 9_990, localityIds: [] },
      errors: {},
    });
    expect(Object.keys(zoneInput({ key: 1, id: null, name: ' ', surcharge: '-1', localities: [] }).errors)).toEqual([
      'name',
      'surcharge',
    ]);
  });
});

describe('ShippingPage', () => {
  let fixture: ComponentFixture<ShippingPage>;
  let api: { [K in keyof ShippingApi]: ReturnType<typeof vi.fn> };

  const el = () => fixture.nativeElement as HTMLElement;
  const input = (selector: string) => el().querySelector<HTMLInputElement>(selector)!;
  const type = (selector: string, value: string) => {
    const field = input(selector);
    field.value = value;
    field.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const click = (selector: string) => {
    el().querySelector<HTMLButtonElement>(selector)!.click();
    fixture.detectChanges();
  };
  const settle = async () => {
    await fixture.whenStable();
    fixture.detectChanges();
  };

  beforeEach(async () => {
    api = {
      config: vi.fn().mockResolvedValue(structuredClone(CONFIG)),
      saveRates: vi.fn().mockImplementation(async () => structuredClone(CONFIG)),
      createZone: vi.fn(),
      updateZone: vi.fn(),
      deleteZone: vi.fn().mockResolvedValue(undefined),
      localities: vi.fn().mockResolvedValue([
        { id: 2600, nameHe: 'אילת' },
        { id: 7, nameHe: 'שחר' },
      ]),
    };
    TestBed.configureTestingModule({ providers: [{ provide: ShippingApi, useValue: api }] });
    fixture = TestBed.createComponent(ShippingPage);
    fixture.detectChanges();
    await settle();
  });

  it('shows the prices in shekels and saves them in agorot', async () => {
    expect(input('#rate-1-delivery').value).toBe('400.5');
    expect(input('#rate-2-delivery').value).toBe('');
    expect(input('#additional-item-percent').value).toBe('50');
    type('#rate-2-delivery', '120');
    type('#rate-2-assembly', '80.25');
    type('#floor-surcharge', '60');
    click('button.save-rates');
    await settle();
    expect(api.saveRates).toHaveBeenCalledWith({
      rates: [
        { categoryId: null, deliveryPrice: 15_000, assemblyPrice: 0 },
        { categoryId: 1, deliveryPrice: 40_050, assemblyPrice: 30_000 },
        { categoryId: 2, deliveryPrice: 12_000, assemblyPrice: 8_025 },
      ],
      settings: { additionalItemPercent: 50, floorSurcharge: 6_000, floorSurchargeFrom: 2 },
    });
  });

  it('says when no default price was set yet, next to the default row only', async () => {
    expect(el().querySelector('.default-missing')).toBeNull();
    api.config.mockResolvedValue({ ...structuredClone(CONFIG), defaultRateSet: false });
    fixture = TestBed.createComponent(ShippingPage);
    fixture.detectChanges();
    await settle();
    const hints = el().querySelectorAll('.default-missing');
    expect(hints).toHaveLength(1);
    expect(hints[0].closest('.rate')?.classList).toContain('default');
    expect(hints[0].textContent?.trim()).toBe('עדיין לא נקבע מחיר ברירת מחדל');
  });

  it('does not save invalid values and says what is wrong', async () => {
    type('#additional-item-percent', '150');
    click('button.save-rates');
    await settle();
    expect(api.saveRates).not.toHaveBeenCalled();
    expect(el().querySelector('#additional-item-percent-error')?.textContent).toContain('0 ל-100');
    expect(input('#additional-item-percent').getAttribute('aria-invalid')).toBe('true');
  });

  it('adds a locality from the search to a zone, removes one, and saves the zone', async () => {
    api.updateZone.mockImplementation(async (id: number, body: { name: string; surcharge: number }) => ({
      id,
      ...body,
      localities: [{ id: 7, nameHe: 'שחר' }],
    }));
    const zone = '.zone:first-of-type';
    vi.useFakeTimers();
    try {
      type(`${zone} input[type=search]`, 'שח');
      await vi.advanceTimersByTimeAsync(300);
    } finally {
      vi.useRealTimers();
    }
    await settle();
    expect(api.localities).toHaveBeenCalledWith('שח');
    // Already in this zone: not offered again.
    const results = [...el().querySelectorAll(`${zone} .results button`)];
    expect(results.map((b) => b.textContent!.trim())).toEqual(['שחר']);
    (results[0] as HTMLButtonElement).click();
    fixture.detectChanges();
    expect([...el().querySelectorAll(`${zone} .locality`)].map((c) => c.textContent!.trim())).toEqual(
      expect.arrayContaining([expect.stringContaining('אילת'), expect.stringContaining('שחר')]),
    );
    click(`${zone} button[aria-label="הסרת אילת"]`);
    click(`${zone} button.save-zone`);
    await settle();
    expect(api.updateZone).toHaveBeenCalledWith(7, { name: 'אילת והערבה', surcharge: 25_000, localityIds: [7] });
  });

  it('adds a new zone and names the other zone when a locality is taken', async () => {
    api.createZone.mockRejectedValue(
      new HttpErrorResponse({
        status: 409,
        error: { statusCode: 409, code: 'locality_taken', localityNameHe: 'אילת', zoneName: 'אילת והערבה' },
      }),
    );
    click('button.add-zone');
    const zone = '.zone:last-of-type';
    type(`${zone} .zone-name`, 'דרום');
    type(`${zone} .zone-surcharge`, '100');
    click(`${zone} button.save-zone`);
    await settle();
    expect(api.createZone).toHaveBeenCalledWith({ name: 'דרום', surcharge: 10_000, localityIds: [] });
    expect(el().querySelector(`${zone} [role=alert]`)?.textContent).toContain('אילת והערבה');
  });

  describe('unsaved changes guard', () => {
    let confirmSpy: ReturnType<typeof vi.spyOn>;
    beforeEach(() => {
      confirmSpy = vi.spyOn(window, 'confirm');
    });
    afterEach(() => confirmSpy.mockRestore());

    it('leaves without a prompt when nothing changed', () => {
      expect(fixture.componentInstance.canLeave()).toBe(true);
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('asks first after a rate is edited, and stays when declined', () => {
      type('#rate-2-delivery', '120');
      confirmSpy.mockReturnValue(false);
      expect(fixture.componentInstance.canLeave()).toBe(false);
      expect(confirmSpy).toHaveBeenCalledWith('יש שינויים שלא נשמרו. לצאת בלי לשמור?');
      confirmSpy.mockReturnValue(true);
      expect(fixture.componentInstance.canLeave()).toBe(true);
    });

    it('asks after a setting is edited, and is clean again once the value is restored', () => {
      type('#floor-surcharge', '60');
      confirmSpy.mockReturnValue(false);
      expect(fixture.componentInstance.canLeave()).toBe(false);
      type('#floor-surcharge', '50');
      expect(fixture.componentInstance.canLeave()).toBe(true);
    });

    it('is clean again after saving', async () => {
      type('#rate-2-delivery', '120');
      type('#rate-2-assembly', '80');
      click('button.save-rates');
      await settle();
      expect(api.saveRates).toHaveBeenCalled();
      expect(fixture.componentInstance.canLeave()).toBe(true);
      expect(confirmSpy).not.toHaveBeenCalled();
    });

    it('asks while a new or edited zone is unsaved', async () => {
      confirmSpy.mockReturnValue(false);
      type('.zone .zone-name', 'אילת והערבה 2');
      expect(fixture.componentInstance.canLeave()).toBe(false);
      type('.zone .zone-name', 'אילת והערבה');
      expect(fixture.componentInstance.canLeave()).toBe(true);
      click('button.add-zone');
      expect(fixture.componentInstance.canLeave()).toBe(false);
      click('.zone:last-of-type button.delete-zone');
      await settle();
      expect(fixture.componentInstance.canLeave()).toBe(true);
    });

    it('warns the browser tab (beforeunload) only while dirty', () => {
      const event = () => {
        const e = new Event('beforeunload', { cancelable: true });
        window.dispatchEvent(e);
        return e.defaultPrevented;
      };
      expect(event()).toBe(false);
      type('#rate-2-delivery', '120');
      expect(event()).toBe(true);
    });
  });
});
