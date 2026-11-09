import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { FulfillmentMode, ProductCard, ProductDetail, RelatedProducts, VariantDetail } from '@hg/models';
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
    id: 1,
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

const card = (id: number): ProductCard => ({
  id,
  slug: `p${id}`,
  modelName: `MODEL${id}`,
  nameHe: `מוצר ${id}`,
  priceFrom: 100000,
  compareAtFrom: null,
  discountPercent: null,
  hasPriceRange: false,
  swatches: [],
  image: null,
  fulfillment: 'in_stock',
  leadTimeDays: 14,
  isNew: false,
});

const beige240 = variant('B240', { color: 'beige', size: '240' }, 300000);
const beige280 = variant('B280', { color: 'beige', size: '280' }, 350000);
const green240 = variant('G240', { color: 'green', size: '240' }, 320000);
const three = () => product([beige240, beige280, green240]);

/**
 * Shaped like the real `GET /api/products/alba-corner-sofa` response (Phase 3b seed): color, fabric,
 * the size axis the API derives from the variant widths, and chaise side (fewer colors to keep it short).
 */
function alba(): ProductDetail {
  const sizes = [
    { width: 260, weightKg: 72, chaiseDepthCm: 165, price: { woven: 459000, boucle: 505000 } },
    { width: 300, weightKg: 78, chaiseDepthCm: 165, price: { woven: 499000, boucle: 549000 } },
    { width: 340, weightKg: 86, chaiseDepthCm: 175, price: { woven: 559000, boucle: 615000 } },
  ];
  const colors = { beige: 'BG', gray: 'GR' } as const;
  const fabrics = { woven: 'WV', boucle: 'BC' } as const;
  const sides = { right: 'R', left: 'L' } as const;
  const variants: VariantDetail[] = [];
  for (const s of sizes)
    for (const [color, c] of Object.entries(colors))
      for (const [fabric, f] of Object.entries(fabrics))
        for (const [side, d] of Object.entries(sides))
          variants.push({
            sku: `ALBA-${s.width}-${c}-${f}-${d}`,
            price: s.price[fabric as keyof typeof fabrics],
            compareAtPrice: null,
            inStock: true,
            fulfillment: 'in_stock',
            leadTimeDays: 14,
            productionDays: null,
            expectedAt: null,
            dimensions: {
              widthCm: s.width,
              depthCm: 95,
              heightCm: 82,
              weightKg: s.weightKg,
              seatHeightCm: 44,
              seatDepthCm: 58,
              chaiseWidthCm: 95,
              chaiseDepthCm: s.chaiseDepthCm,
            },
            options: { color, fabric, 'chaise-side': side, size: String(s.width) },
            images: [],
          });
  return {
    ...product(variants, false, 'alba-corner-sofa', 'ספה פינתית אלבה'),
    optionAxes: [
      {
        code: 'color',
        nameHe: 'צבע',
        values: [
          { code: 'beige', labelHe: 'בז׳', hex: '#D8CBB5' },
          { code: 'gray', labelHe: 'אפור', hex: '#9A958D' },
        ],
      },
      {
        code: 'fabric',
        nameHe: 'סוג בד',
        values: [
          { code: 'woven', labelHe: 'אריג', hex: null },
          { code: 'boucle', labelHe: 'בוקלה', hex: null },
        ],
      },
      {
        code: 'size',
        nameHe: 'מידה',
        values: sizes.map((s) => ({ code: String(s.width), labelHe: `${s.width} ס״מ`, hex: null })),
      },
      {
        code: 'chaise-side',
        nameHe: 'צד הפינה או השזלונג',
        values: [
          { code: 'right', labelHe: 'ימין', hex: null },
          { code: 'left', labelHe: 'שמאל', hex: null },
        ],
      },
    ],
  };
}

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

  async function load(
    harness: RouterTestingHarness,
    url: string,
    body: ProductDetail | 404,
    slug = 'alba',
    related: RelatedProducts = { goesWith: [], similar: [] },
  ) {
    await harness.navigateByUrl(url);
    const req = http.expectOne(`/api/products/${slug}`);
    const relatedReq = http.expectOne(`/api/products/${slug}/related`);
    if (body === 404) req.flush({}, { status: 404, statusText: 'Not Found' });
    else req.flush(body);
    relatedReq.flush(related);
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

  it('has a favorites button next to the title (CMP-01)', async () => {
    localStorage.clear();
    const h = await open('/product/alba', three());
    const heart = el(h).querySelector<HTMLButtonElement>('.title-row hg-favorite-button button')!;
    expect(heart.getAttribute('aria-pressed')).toBe('false');
    heart.click();
    h.detectChanges();
    expect(heart.getAttribute('aria-pressed')).toBe('true');
    expect(JSON.parse(localStorage.getItem('hg.favorites')!)).toEqual([1]);
    localStorage.clear();
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
    const notice = el(h).querySelector('hg-variant-picker [aria-live="polite"]');
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

  it('an API error shows a message and a retry button that loads the product again', async () => {
    const serverError = vi.spyOn(TestBed.inject(PageMeta), 'serverError');
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/product/alba?color=green&size=240');
    http.expectOne('/api/products/alba').flush({}, { status: 500, statusText: 'Server Error' });
    http.expectOne('/api/products/alba/related').flush({}, { status: 500, statusText: 'Server Error' });
    await h.fixture.whenStable();
    h.detectChanges();
    expect(serverError).toHaveBeenCalled();
    expect(text(h)).toContain('לא הצלחנו לטעון את המוצר. נסו שוב.');
    expect(text(h)).not.toContain('המוצר לא נמצא');
    const retry = el(h).querySelector<HTMLButtonElement>('button.btn-secondary')!;
    expect(retry.textContent?.trim()).toBe('נסו שוב');
    expect(el(h).querySelector('.btn-primary')).toBeNull();

    retry.click();
    http.expectOne('/api/products/alba').flush(three());
    http.expectOne('/api/products/alba/related').flush({ goesWith: [], similar: [] });
    await h.fixture.whenStable();
    h.detectChanges();
    expect(text(h)).not.toContain('לא הצלחנו לטעון');
    expect(el(h).querySelector('h1')?.textContent).toContain('ספה אלבה');
    expect(text(h)).toContain('3,200 ₪');
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

  it('clicking a thumbnail changes the shown photo and it stays after re-rendering', async () => {
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

  const dimension = (h: RouterTestingHarness, label: string) =>
    Array.from(el(h).querySelectorAll('hg-product-details tr'))
      .find((tr) => tr.querySelector('th')?.textContent?.trim() === label)
      ?.querySelector('td')
      ?.textContent?.trim();

  it('size is a choice: picking one updates the price and the dimensions table (PRD-04)', async () => {
    const h = await load(await RouterTestingHarness.create(), '/product/alba-corner-sofa', alba(), 'alba-corner-sofa');
    expect(radio(h, '260 ס״מ').getAttribute('aria-checked')).toBe('true');
    expect(el(h).querySelector('.price-now')?.textContent).toContain('4,590 ₪');
    expect(dimension(h, 'רוחב')).toBe('260 ס״מ');

    radio(h, '340 ס״מ').click();
    h.detectChanges();
    const page = h.routeDebugElement!.componentInstance as ProductPage;
    expect(page.variant()?.sku).toBe('ALBA-340-BG-WV-R');
    expect(el(h).querySelector('.price-now')?.textContent).toContain('5,590 ₪');
    expect(dimension(h, 'רוחב')).toBe('340 ס״מ');
    expect(dimension(h, 'עומק שזלונג')).toBe('175 ס״מ');
    expect(page.notice()).toBeNull();
  });

  it('?size=300 in the URL renders the 300 cm variant (PRD-04)', async () => {
    const shared = await load(
      await RouterTestingHarness.create(),
      '/product/alba-corner-sofa?size=300',
      alba(),
      'alba-corner-sofa',
    );
    expect((shared.routeDebugElement!.componentInstance as ProductPage).variant()?.sku).toBe('ALBA-300-BG-WV-R');
    expect(radio(shared, '300 ס״מ').getAttribute('aria-checked')).toBe('true');
    expect(el(shared).querySelector('.price-now')?.textContent).toContain('4,990 ₪');
    expect(dimension(shared, 'רוחב')).toBe('300 ס״מ');
  });

  const rows = (h: RouterTestingHarness) => Array.from(el(h).querySelectorAll('hg-product-row'));
  const rowModels = (row: Element) =>
    Array.from(row.querySelectorAll('hg-product-card .model')).map((m) => m.textContent?.trim());

  it('renders both rows from the API', async () => {
    const h = await load(await RouterTestingHarness.create(), '/product/alba', three(), 'alba', {
      goesWith: [card(10), card(11)],
      similar: [card(20)],
    });
    const [goesWith, similar] = rows(h);
    expect(goesWith.querySelector('h2')?.textContent).toContain('הולך מושלם עם');
    expect(rowModels(goesWith)).toEqual(['MODEL10', 'MODEL11']);
    expect(similar.querySelector('h2')?.textContent).toContain('מוצרים דומים');
    expect(rowModels(similar)).toEqual(['MODEL20']);
    // below the details accordion
    const details = el(h).querySelector('hg-product-details')!;
    expect(details.compareDocumentPosition(goesWith) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders no rows when related fails while the product still renders', async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/product/alba');
    http.expectOne('/api/products/alba').flush(three());
    http.expectOne('/api/products/alba/related').flush({}, { status: 404, statusText: 'Not Found' });
    await h.fixture.whenStable();
    h.detectChanges();
    expect(el(h).querySelector('h1')?.textContent).toContain('ספה אלבה');
    expect(text(h)).not.toContain('לא הצלחנו לטעון');
    expect(rows(h).every((r) => !r.querySelector('section'))).toBe(true);
    expect(el(h).querySelector('hg-product-card')).toBeNull();
  });

  it('reloads related on slug change and ignores a late response for the old slug', async () => {
    const h = await RouterTestingHarness.create();
    await h.navigateByUrl('/product/alba');
    const oldProduct = http.expectOne('/api/products/alba');
    const oldRelated = http.expectOne('/api/products/alba/related');
    await h.navigateByUrl('/product/other');
    http.expectOne('/api/products/other').flush(product([variant('O', {}, 55500)], false, 'other', 'ספה אחרת'));
    http.expectOne('/api/products/other/related').flush({ goesWith: [card(30)], similar: [] });
    // The old slug's answers arrive after the new ones.
    oldProduct.flush(three());
    oldRelated.flush({ goesWith: [card(99)], similar: [card(98)] });
    await h.fixture.whenStable();
    h.detectChanges();
    expect(el(h).querySelector('h1')?.textContent).toContain('ספה אחרת');
    expect(rowModels(rows(h)[0])).toEqual(['MODEL30']);
    expect(el(h).textContent).not.toContain('MODEL99');
  });
});
