import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { ProductCard } from '@hg/models';
import { FavoritesStore } from '../core/favorites.store';
import { PageMeta } from '../core/page-meta';
import { FavoritesPage } from './favorites.page';

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

describe('FavoritesPage', () => {
  let fixture: ComponentFixture<FavoritesPage>;
  let http: HttpTestingController;
  let favorites: FavoritesStore;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const models = () => Array.from(el().querySelectorAll('hg-product-card .model')).map((m) => m.textContent?.trim());

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    favorites = TestBed.inject(FavoritesStore);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
  });

  afterEach(() => {
    http.verify();
    localStorage.clear();
  });

  async function open() {
    fixture = TestBed.createComponent(FavoritesPage);
    fixture.detectChanges();
    TestBed.tick(); // runs afterNextRender, where the page loads its cards
  }

  async function settle() {
    await fixture.whenStable();
    fixture.detectChanges();
  }

  it('renders cards in store order', async () => {
    for (const id of [1, 2, 3]) favorites.toggle(id);
    await open();
    expect(metaSet).toHaveBeenCalledWith({
      title: 'המועדפים שלי',
      description: 'המוצרים ששמרתם',
      path: '/favorites',
      noindex: true,
    });
    const req = http.expectOne((r) => r.url === '/api/products/cards');
    expect(req.request.params.get('ids')).toBe('3,2,1');
    req.flush([card(2), card(3), card(1)]);
    await settle();
    expect(models()).toEqual(['MODEL3', 'MODEL2', 'MODEL1']);
    expect(favorites.ids()).toEqual([3, 2, 1]);
  });

  it('drops ids the API did not return', async () => {
    for (const id of [1, 2, 3]) favorites.toggle(id);
    await open();
    http.expectOne((r) => r.url === '/api/products/cards').flush([card(3), card(1)]);
    await settle();
    expect(models()).toEqual(['MODEL3', 'MODEL1']);
    expect(favorites.ids()).toEqual([3, 1]);
  });

  it('shows the empty state', async () => {
    await open();
    await settle();
    expect(el().textContent).toContain('עוד לא שמרתם מוצרים');
    const home = el().querySelector<HTMLAnchorElement>('a[href="/"]');
    expect(home?.textContent?.trim()).toBe('לדף הבית');
    expect(el().querySelector('hg-product-card')).toBeNull();
  });
});
