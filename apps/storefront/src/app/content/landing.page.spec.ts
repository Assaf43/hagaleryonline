import { RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import type { ImageRef, LandingPageView, ProductCard } from '@hg/models';
import { LandingPage, sortLandingItems } from './landing.page';

const img = {
  url: '/media/a.webp',
  srcset: null,
  avifSrcset: null,
  width: 1200,
  height: 800,
  altHe: 'x',
} as unknown as ImageRef;
const card = (id: number, priceFrom: number) =>
  ({
    id,
    slug: `p${id}`,
    modelName: `P${id}`,
    nameHe: `מוצר ${id}`,
    image: img,
    swatches: [],
    priceFrom,
    compareAtFrom: null,
    discountPercent: null,
    memberPriceFrom: null,
    memberPriceFromRegular: null,
    hasPriceRange: false,
    fulfillment: 'in_stock',
    leadTimeDays: 0,
    isNew: false,
  }) as unknown as ProductCard;

const view = (over: Partial<LandingPageView> = {}): LandingPageView => ({
  slug: 'winter',
  titleHe: 'קולקציית חורף',
  sublineHe: 'ספות חמות',
  introHtml: '<p>פתיחה</p>',
  outroHtml: '<p>עד גמר המלאי</p>',
  image: img,
  mobileImage: null,
  altHe: 'חורף',
  items: [card(1, 300), card(2, 100), card(3, 200)],
  newestOrder: [3, 1, 2],
  metaDescriptionHe: null,
  noindex: false,
  ...over,
});

describe('LandingPage', () => {
  function open(inputs: Record<string, string> = {}) {
    const response: { status?: number } = {};
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: RESPONSE_INIT, useValue: response },
      ],
    });
    const fixture = TestBed.createComponent(LandingPage);
    fixture.componentRef.setInput('slug', 'winter');
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController), response };
  }
  const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
    await f.whenStable();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
  };
  const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute('content');
  const order = (el: HTMLElement) =>
    [...el.querySelectorAll('hg-product-card')].map((c) => c.textContent?.match(/P\d/)?.[0]);

  it('renders a live page: title, subline, intro, count, grid, closing text', async () => {
    const { fixture, http } = open();
    http.expectOne('/api/content/landing/winter').flush({ state: 'live', page: view() });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('קולקציית חורף');
    expect(el.querySelector('.subline')?.textContent).toBe('ספות חמות');
    expect(el.textContent).toContain('פתיחה');
    expect(el.textContent).toContain('3 מוצרים');
    expect(el.querySelectorAll('hg-product-card').length).toBe(3);
    expect(el.querySelector('.outro')?.textContent).toContain('עד גמר המלאי');
    expect(el.querySelector('.preview-strip')).toBeNull();
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(/\/collection\/winter$/);
  });

  it('sorts on the client and keeps the sort in the URL', async () => {
    const { fixture, http } = open({ sort: 'price_asc' });
    http.expectOne('/api/content/landing/winter').flush({ state: 'live', page: view() });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(order(el)).toEqual(['P2', 'P3', 'P1']);
    fixture.componentRef.setInput('sort', 'newest');
    await settle(fixture);
    expect(order(el)).toEqual(['P3', 'P1', 'P2']);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const select = el.querySelector('select') as HTMLSelectElement;
    select.value = 'price_desc';
    select.dispatchEvent(new Event('change'));
    expect(navigate).toHaveBeenCalledWith(
      [],
      expect.objectContaining({ queryParams: { sort: 'price_desc' }, replaceUrl: true }),
    );
  });

  it('keeps the source order for "recommended"', () => {
    const items = [card(1, 3), card(2, 1)];
    expect(sortLandingItems(items, [], 'recommended').map((c) => c.id)).toEqual([1, 2]);
  });

  it('says there are no products for an empty grid', async () => {
    const { fixture, http } = open();
    http.expectOne('/api/content/landing/winter').flush({ state: 'live', page: view({ items: [], newestOrder: [] }) });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('אין כרגע מוצרים להצגה');
    expect(el.querySelector('select')).toBeNull();
  });

  it('shows the ended page with a 410, noindex and a button to the ended link', async () => {
    const { fixture, http, response } = open();
    http
      .expectOne('/api/content/landing/winter')
      .flush(
        { state: 'ended', titleHe: 'קולקציית חורף', endedLinkUrl: '/category/sofas' },
        { status: 410, statusText: 'Gone' },
      );
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(response.status).toBe(410);
    expect(robots()).toBe('noindex, follow');
    expect(el.textContent).toContain('המבצע הסתיים');
    expect(el.querySelector('a.btn')?.getAttribute('href')).toBe('/category/sofas');
  });

  it('an ended page canonicalizes to its own path', async () => {
    const { fixture, http } = open();
    http
      .expectOne('/api/content/landing/winter')
      .flush({ state: 'ended', titleHe: 'x', endedLinkUrl: '/' }, { status: 410, statusText: 'Gone' });
    await settle(fixture);
    expect(document.head.querySelector('link[rel="canonical"]')?.getAttribute('href')).toMatch(/\/collection\/winter$/);
  });

  it('survives a 410 with no body: generic ended state, still 410', async () => {
    const { fixture, http, response } = open();
    http.expectOne('/api/content/landing/winter').flush(null, { status: 410, statusText: 'Gone' });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(response.status).toBe(410);
    expect(el.textContent).toContain('המבצע הסתיים');
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('an external ended link opens with rel="noopener"', async () => {
    const { fixture, http } = open();
    http
      .expectOne('/api/content/landing/winter')
      .flush(
        { state: 'ended', titleHe: 'x', endedLinkUrl: 'https://example.com/sale' },
        { status: 410, statusText: 'Gone' },
      );
    await settle(fixture);
    const a = (fixture.nativeElement as HTMLElement).querySelector('a.btn');
    expect(a?.getAttribute('href')).toBe('https://example.com/sale');
    expect(a?.getAttribute('rel')).toBe('noopener');
  });

  it('answers 404 for an unknown page', async () => {
    const { fixture, http, response } = open();
    http
      .expectOne('/api/content/landing/winter')
      .flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await settle(fixture);
    expect(response.status).toBe(404);
    expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe('הדף לא נמצא');
  });

  it('shows a retry and answers 503 on other errors', async () => {
    const { fixture, http, response } = open();
    http.expectOne('/api/content/landing/winter').flush({}, { status: 500, statusText: 'x' });
    await settle(fixture);
    expect(response.status).toBe(503);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role="alert"]')).not.toBeNull();
  });

  it('a preview sends the token, shows the strip and is noindex', async () => {
    const { fixture, http } = open({ preview: 'tok.1.sig' });
    const req = http.expectOne((r) => r.url === '/api/content/landing/winter');
    expect(req.request.params.get('preview')).toBe('tok.1.sig');
    expect(req.request.transferCache).toBe(false);
    req.flush({ state: 'preview', page: view() });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.preview-strip')?.textContent).toBe('תצוגה מקדימה');
    expect(robots()).toBe('noindex, follow');
  });
});
