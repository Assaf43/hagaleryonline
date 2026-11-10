import { auditDiff, ratesAuditView, shekels, zoneAuditView } from './shipping-audit.js';

const SETTINGS = { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 };

describe('shipping audit entries', () => {
  it('writes amounts as shekels', () => {
    expect(shekels(45_000)).toBe('₪450');
    expect(shekels(12_345_67)).toBe('₪12,345.67');
    expect(shekels(0)).toBe('₪0');
  });

  it('shows the price list with Hebrew keys and readable values', () => {
    expect(
      ratesAuditView(
        [
          { categoryId: null, categoryNameHe: 'ברירת מחדל', deliveryPrice: 45_000, assemblyPrice: 20_000 },
          { categoryId: 3, categoryNameHe: 'ספות', deliveryPrice: null, assemblyPrice: null },
          { categoryId: 4, categoryNameHe: 'ספות', deliveryPrice: 1_050, assemblyPrice: 0 },
        ],
        SETTINGS,
      ),
    ).toEqual({
      'ברירת מחדל': 'הובלה ₪450 / הרכבה ₪200',
      ספות: 'ללא מחיר משלו',
      'ספות (#4)': 'הובלה ₪10.5 / הרכבה ₪0',
      'הנחה לפריט נוסף': '50%',
      'תוספת לקומה': '₪50',
      מקומה: '2',
    });
  });

  it('shows a zone with its localities by name', () => {
    expect(
      zoneAuditView({
        id: 1,
        name: 'אילת',
        surcharge: 25_000,
        localities: [
          { id: 2600, nameHe: 'אילת' },
          { id: 7, nameHe: 'שחר' },
        ],
      }),
    ).toEqual({ שם: 'אילת', תוספת: '₪250', יישובים: 'אילת, שחר' });
    expect(zoneAuditView({ id: 1, name: 'א', surcharge: 0, localities: [] })['יישובים']).toBe('ללא יישובים');
  });

  it('keeps only the keys that changed, or null when nothing did', () => {
    expect(auditDiff({ a: '1', b: '2' }, { a: '1', b: '3' })).toEqual({ before: { b: '2' }, after: { b: '3' } });
    expect(auditDiff({ a: '1' }, { a: '1' })).toBeNull();
  });
});
