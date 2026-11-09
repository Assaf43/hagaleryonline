import { ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import type { ProductDetail, VariantDetail } from '@hg/models';
import { ProductDetails } from './product-details';
import { SHIPPING_INFO } from './shipping-info';

const variant = (widthCm: number): VariantDetail =>
  ({
    sku: `S${widthCm}`,
    dimensions: {
      widthCm,
      depthCm: 100,
      heightCm: 80,
      weightKg: null,
      seatHeightCm: null,
      seatDepthCm: null,
      chaiseWidthCm: null,
      chaiseDepthCm: null,
    },
  }) as VariantDetail;

const product = (over: Partial<ProductDetail> = {}): ProductDetail =>
  ({
    descriptionHe: '<p>ספה נוחה</p>',
    specs: [],
    countryOfOrigin: null,
    warrantyMonths: null,
    careHe: null,
    requiresAssembly: false,
    ...over,
  }) as ProductDetail;

describe('ProductDetails', () => {
  let fixture: ComponentFixture<ProductDetails>;
  const el = () => fixture.nativeElement as HTMLElement;

  async function setup(p: ProductDetail, v: VariantDetail) {
    fixture = TestBed.createComponent(ProductDetails);
    fixture.componentRef.setInput('product', p);
    fixture.componentRef.setInput('variant', v);
    fixture.detectChanges();
    await fixture.whenStable();
  }
  const sections = () => Array.from(el().querySelectorAll('details'));
  const rows = (section: number) =>
    Array.from(sections()[section].querySelectorAll('tr')).map((tr) => [
      tr.querySelector('th')?.textContent?.trim(),
      tr.querySelector('td')?.textContent?.trim(),
    ]);

  it('details renders four sections with the description open', async () => {
    await setup(product(), variant(280));
    const s = sections();
    expect(s.map((d) => d.querySelector('summary')?.textContent?.trim())).toEqual([
      'תיאור',
      'מידות',
      'מפרט',
      'משלוח, הרכבה והחזרות',
    ]);
    expect(s.map((d) => d.open)).toEqual([true, false, false, false]);
    expect(s[0].querySelector('p')?.textContent).toBe('ספה נוחה');
    expect(el().querySelectorAll('th[scope="row"]').length).toBeGreaterThan(0);
  });

  it('dimensions follow the variant', async () => {
    await setup(product(), variant(280));
    expect(rows(1)[0]).toEqual(['רוחב', '280 ס״מ']);
    fixture.componentRef.setInput('variant', variant(240));
    fixture.detectChanges();
    expect(rows(1)[0]).toEqual(['רוחב', '240 ס״מ']);
  });

  it('specs skip empty rows', async () => {
    await setup(
      product({
        specs: [
          { code: 'style', nameHe: 'סגנון', valuesHe: ['מודרני', 'קלאסי'] },
          { code: 'empty', nameHe: 'ריק', valuesHe: [] },
        ],
        warrantyMonths: 24,
      }),
      variant(280),
    );
    expect(rows(2)).toEqual([
      ['סגנון', 'מודרני, קלאסי'],
      ['אחריות', '24 חודשים'],
      ['הרכבה', 'מגיע מורכב'],
    ]);
    fixture.componentRef.setInput('product', product({ requiresAssembly: true, careHe: 'ניגוב עדין' }));
    fixture.detectChanges();
    expect(rows(2)).toEqual([
      ['הוראות תחזוקה', 'ניגוב עדין'],
      ['הרכבה', 'נדרשת הרכבה'],
    ]);
  });

  it('shipping section shows the interim paragraphs', async () => {
    await setup(product(), variant(280));
    const ps = Array.from(sections()[3].querySelectorAll('p')).map((p) => p.textContent);
    expect(ps).toEqual([...SHIPPING_INFO.paragraphsHe]);
  });
});
