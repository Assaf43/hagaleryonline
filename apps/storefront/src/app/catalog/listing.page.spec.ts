import { RESPONSE_INIT } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import type { CategoryNode, ProductCard, ProductListResponse } from '@hg/models';
import { SEO_INDEXING } from '../core/server-tokens';
import { ListingPage } from './listing.page';
import { PAGE_SIZE } from './listing-state';

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

const sofas = { id: 1, slug: 'sofas', nameHe: 'ספות', children: [] } as unknown as CategoryNode;

function list(from: number, count: number, total: number): ProductListResponse {
  return {
    items: Array.from({ length: count }, (_, i) => card(from + i)),
    total,
    facets: [],
  } as unknown as ProductListResponse;
}

describe('ListingPage load failure', () => {
  let http: HttpTestingController;
  let response: { status?: number };
  const robots = () => document.head.querySelector('meta[name="robots"]')?.getAttribute('content');
  const ld = () => document.head.querySelectorAll('script#ld').length;

  beforeEach(() => {
    response = {};
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: RESPONSE_INIT, useValue: response },
        { provide: SEO_INDEXING, useValue: true },
        provideRouter([{ path: 'category/:slug', component: ListingPage, data: { kind: 'category' } }]),
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });

  /** Waits for the page's request to `url` (the router and the page load asynchronously). */
  async function request(url: string) {
    for (let i = 0; i < 100; i++) {
      const found = http.match((r) => r.url === url);
      if (found.length) return found[0];
      await new Promise((r) => setTimeout(r));
    }
    throw new Error(`no request to ${url}`);
  }

  async function openOk(harness: RouterTestingHarness) {
    const nav = harness.navigateByUrl('/category/sofas');
    (await request('/api/rooms')).flush([]);
    (await request('/api/categories')).flush([sofas]);
    (await request('/api/products')).flush(list(1, PAGE_SIZE, PAGE_SIZE * 2));
    await nav;
    await harness.fixture.whenStable();
  }

  it('a failed first load answers 503, noindex and no ld+json', async () => {
    const harness = await RouterTestingHarness.create();
    const nav = harness.navigateByUrl('/category/sofas');
    (await request('/api/rooms')).flush([]);
    (await request('/api/categories')).flush([sofas]);
    (await request('/api/products')).flush({}, { status: 500, statusText: 'Server Error' });
    await nav;
    await harness.fixture.whenStable();
    expect(response.status).toBe(503);
    expect(robots()).toBe('noindex, follow');
    expect(ld()).toBe(0);
  });

  it('a failed "load more" leaves the page meta alone', async () => {
    const harness = await RouterTestingHarness.create();
    await openOk(harness);
    expect(response.status).toBeUndefined();
    expect(ld()).toBe(1);
    const title = document.title;
    const link = (harness.routeNativeElement as HTMLElement).querySelector<HTMLElement>('a.btn-secondary');
    expect(link).toBeTruthy();
    link!.click();
    (await request('/api/products')).flush({}, { status: 500, statusText: 'Server Error' });
    await harness.fixture.whenStable();
    expect(response.status).toBeUndefined();
    expect(document.title).toBe(title);
    expect(ld()).toBe(1);
  });
});
