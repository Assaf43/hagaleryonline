import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { FulfillmentMode, ProductDetail, VariantDetail } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { ProductPage } from './product.page';
import { adjustmentNotice } from './variant-selection';

function variant(
  sku: string,
  options: Record<string, string>,
  price: number,
  fulfillment: FulfillmentMode = 'in_stock',
  compareAtPrice: number | null = null,
): VariantDetail {
  return {
    sku,
    price,
    compareAtPrice,
    inStock: fulfillment === 'in_stock',
    fulfillment,
    leadTimeDays: 14,
    productionDays: null,
    expectedAt: null,
    dimensions: { widthCm: 280, depthCm: 100, heightCm: 80 } as VariantDetail['dimensions'],
    options,
    images: [],
  };
}

function product(variants: VariantDetail[], withAxes = true, slug = 'alba', nameHe = 'ספה אלבה'): ProductDetail {
  return {
    slug,
    modelName: slug.toUpperCase(),
    nameHe,
    descriptionHe: '<p>ספה נוחה</p>',
    breadcrumbs: [{ slug: 'sofas', nameHe: 'ספות' }],
    rooms: [],
    specs: [],
    countryOfOrigin: null,
    warrantyMonths: null,
    careHe: null,
    requiresAssembly: false,
    images: [],
    optionAxes: withAxes
      ? [
          {
            code: 'color',
            nameHe: 'צבע',
            values: [
              { code: 'beige', labelHe: 'בז׳', hex: '#D8CBB5' },
              { code: 'green', labelHe: 'ירוק', hex: '#5B7B5A' },
            ],
          },
          {
            code: 'size',
            nameHe: 'גודל',
            values: [
              { code: '240', labelHe: '240 ס״מ', hex: null },
              { code: '280', labelHe: '280 ס״מ', hex: null },
            ],
          },
        ]
      : [],
    variants,
  };
}

const beige240 = variant('B240', { color: 'beige', size: '240' }, 300000);
const beige280 = variant('B280', { color: 'beige', size: '280' }, 350000);
const green240 = variant('G240', { color: 'green', size: '240' }, 320000);
const three = () => product([beige240, beige280, green240]);

describe('ProductPage', () => {
  let http: HttpTestingController;
  let router: Router;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([{ path: 'product/:slug', component: ProductPage }], withComponentInputBinding()),
      ],
    });
    http = TestBed.inject(HttpTestingController);
    router = TestBed.inject(Router);
  });

  async function load(harness: RouterTestingHarness, url: string, body: ProductDetail | 404, slug = 'alba') {
    await harness.navigateByUrl(url);
    const req = http.expectOne(`/api/products/${slug}`);
    if (body === 404) req.flush({}, { status: 404, statusText: 'Not Found' });
    else req.flush(body);
    await harness.fixture.whenStable();
    harness.detectChanges();
    return harness;
  }
  async function open(url: string, body: ProductDetail | 404) {
    return load(await RouterTestingHarness.create(), url, body);
  }
  const el = (h: RouterTestingHarness) => h.routeNativeElement as HTMLElement;
  const text = (h: RouterTestingHarness) => el(h).textContent ?? '';
  const radio = (h: RouterTestingHarness, label: string) =>
    Array.from(el(h).querySelectorAll<HTMLElement>('[role="radio"]')).find(
      (r) => r.textContent?.includes(label) || r.getAttribute('aria-label')?.includes(label),
    )!;

  it('renders the variant named in the URL', async () => {
    const h = await open('/product/alba?color=green&size=240', three());
    expect(text(h)).toContain('3,200 ₪');
    expect(radio(h, 'ירוק').getAttribute('aria-checked')).toBe('true');
    expect(radio(h, 'בז׳').getAttribute('aria-checked')).toBe('false');
    expect(radio(h, '240').getAttribute('aria-checked')).toBe('true');
    expect(el(h).querySelector('h1')?.textContent).toContain('ספה אלבה');
    expect(text(h)).toContain('ALBA');
  });

  it('ignores unknown params and shows the default variant', async () => {
    const h = await open('/product/alba?color=purple&foo=1', three());
    expect(text(h)).toContain('3,000 ₪');
    expect(radio(h, 'בז׳').getAttribute('aria-checked')).toBe('true');
  });

  it('picking an option updates the URL with replaceUrl', async () => {
    const h = await open('/product/alba?color=beige&size=240', three());
    const spy = vi.spyOn(router, 'navigate');
    radio(h, '280').click();
    h.detectChanges();
    expect(spy).toHaveBeenCalledTimes(1);
    const [commands, extras] = spy.mock.calls[0];
    expect(commands).toEqual([]);
    expect(extras?.queryParams).toEqual({ color: 'beige', size: '280' });
    expect(extras?.replaceUrl).toBe(true);
    expect(text(h)).toContain('3,500 ₪');
  });

  it('picking an unavailable option shows the notice', async () => {
    const h = await open('/product/alba?color=beige&size=280', three());
    radio(h, 'ירוק').click();
    h.detectChanges();
    const page = h.routeDebugElement!.componentInstance as ProductPage;
    const expected = adjustmentNotice(['size'], three().optionAxes, green240);
    expect(expected).toBeTruthy();
    expect(page.notice()).toBe(expected);
    const notice = el(h).querySelector('[aria-live="polite"]');
    expect(notice?.textContent?.trim()).toBe(expected);
    expect(text(h)).toContain('3,200 ₪');
  });

  it('single-variant product renders without a picker', async () => {
    const h = await open('/product/alba', product([variant('ONE', {}, 100000)], false));
    expect(el(h).querySelector('[role="radiogroup"]')).toBeNull();
    expect(text(h)).toContain('1,000 ₪');
  });

  it('sale price shows the struck compare-at price and the discount badge', async () => {
    const h = await open('/product/alba', product([variant('S', {}, 80000, 'in_stock', 100000)], false));
    expect(el(h).querySelector('s')?.textContent).toContain('1,000 ₪');
    expect(el(h).querySelector('.badge-sale')?.textContent).toContain('20');
    expect(el(h).querySelector('.price-now')?.textContent).toContain('800 ₪');
  });

  it('shows the delivery line of an in-stock variant', async () => {
    const h = await open('/product/alba?color=beige&size=240', three());
    expect(el(h).querySelector('hg-delivery-line')?.textContent).toContain('אספקה עד 14 ימי עסקים');
  });

  it('shows the delivery line of an out-of-stock variant', async () => {
    const h = await open('/product/alba', product([variant('X', {}, 100000, 'out_of_stock')], false));
    expect(el(h).querySelector('hg-delivery-line')?.textContent).toContain('אזל');
  });

  it('unknown slug sets notFound', async () => {
    const spy = vi.spyOn(TestBed.inject(PageMeta), 'notFound');
    const h = await open('/product/alba', 404);
    expect(spy).toHaveBeenCalled();
    expect(text(h)).toContain('המוצר לא נמצא');
  });

  it('a product without variants is treated as not found', async () => {
    const spy = vi.spyOn(TestBed.inject(PageMeta), 'notFound');
    await open('/product/alba', product([]));
    expect(spy).toHaveBeenCalled();
  });

  it('loads the new product when the slug changes (component reuse)', async () => {
    const h = await open('/product/alba?color=green', three());
    expect(el(h).querySelector('h1')?.textContent).toContain('ספה אלבה');
    await load(h, '/product/other', product([variant('O', {}, 55500)], false, 'other', 'ספה אחרת'), 'other');
    expect(el(h).querySelector('h1')?.textContent).toContain('ספה אחרת');
    expect(el(h).querySelector('h1')?.textContent).not.toContain('ספה אלבה');
    expect(text(h)).toContain('555 ₪');
    expect(el(h).querySelector('[role="radiogroup"]')).toBeNull();
  });

  it('follows an external query-param change to the same product and clears the notice', async () => {
    const h = await open('/product/alba?color=beige&size=280', three());
    radio(h, 'ירוק').click();
    h.detectChanges();
    await h.fixture.whenStable();
    const page = h.routeDebugElement!.componentInstance as ProductPage;
    expect(page.notice()).toBeTruthy();
    await router.navigateByUrl('/product/alba?color=beige&size=240');
    await h.fixture.whenStable();
    h.detectChanges();
    expect(page.variant()?.sku).toBe('B240');
    expect(page.notice()).toBeNull();
    expect(text(h)).toContain('3,000 ₪');
  });

  it('sets the canonical path without params and the variant photo as image', async () => {
    const withPhoto = {
      ...variant('P', {}, 100000),
      images: [{ url: '/media/p.webp', altHe: 'תמונה' }],
    };
    const spy = vi.spyOn(TestBed.inject(PageMeta), 'set');
    await open('/product/alba?color=x', product([withPhoto], false));
    expect(spy).toHaveBeenCalled();
    const info = spy.mock.calls.at(-1)![0];
    expect(info.path).toBe('/product/alba');
    expect(info.image).toBe('/media/p.webp');
  });

  it('keeps the chosen photo while the page re-renders, and next really changes it', async () => {
    const photos = ['a', 'b', 'c'].map((n) => ({ url: `/media/${n}.webp`, altHe: n }));
    const p = product([{ ...variant('P', {}, 100000), images: photos }], false);
    const h = await open('/product/alba', p);
    const thumbs = () => Array.from(el(h).querySelectorAll<HTMLButtonElement>('.thumb'));
    const main = () => el(h).querySelector('.main img')?.getAttribute('src');
    expect(main()).toBe('/media/a.webp');
    thumbs()[1].click();
    h.detectChanges();
    h.detectChanges();
    expect(main()).toBe('/media/b.webp');
    expect(thumbs()[1].getAttribute('aria-current')).toBe('true');
  });
});
