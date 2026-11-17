import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { BannerView, HomeSectionView, HomeView, ImageRef, ProductCard } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { HomePage } from './home.page';

const img = (name: string): ImageRef => ({
  url: `/media/${name}.webp`,
  srcset: `/media/${name}-480.webp 480w`,
  avifSrcset: `/media/${name}-480.avif 480w`,
  width: 1200,
  height: 800,
  altHe: `alt ${name}`,
});

const banner = (over: Partial<BannerView> = {}): BannerView => ({
  id: 1,
  headlineHe: 'מבצע קיץ',
  sublineHe: 'עד 30 אחוז',
  ctaLabelHe: 'לקולקציה',
  linkUrl: '/category/sofas',
  image: img('desk'),
  mobileImage: img('mob'),
  altHe: 'באנר קיץ',
  ...over,
});

const card = (slug: string) =>
  ({
    slug,
    modelName: slug.toUpperCase(),
    nameHe: slug,
    image: img(slug),
    swatches: [],
    priceFrom: 100000,
    compareAtFrom: null,
    discountPercent: null,
    memberPriceFrom: null,
    memberPriceFromRegular: null,
    hasPriceRange: false,
    fulfillment: 'in_stock',
    leadTimeDays: 0,
    isNew: false,
  }) as unknown as ProductCard;

const hero = (b: BannerView | null): HomeSectionView => ({
  id: 1,
  kind: 'hero',
  titleHe: null,
  banner: b,
  fallback: {
    image: img('best'),
    category: { slug: 'sofas', nameHe: 'ספות' },
    room: { slug: 'living-room', nameHe: 'סלון' },
  },
});

async function render(sections: HomeSectionView[]) {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  const fixture = TestBed.createComponent(HomePage);
  fixture.detectChanges();
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/content/home').flush({ sections } satisfies HomeView);
  await fixture.whenStable();
  fixture.detectChanges();
  http.verify();
  return fixture.nativeElement as HTMLElement;
}

describe('HomePage', () => {
  it('renders the default sections like today: static hero, trust, rooms, product rows, one API call', async () => {
    const el = await render([
      hero(null),
      { id: 2, kind: 'trust', titleHe: null },
      {
        id: 3,
        kind: 'rooms',
        titleHe: null,
        rooms: [
          {
            slug: 'living-room',
            nameHe: 'סלון',
            categories: [
              { slug: 'sofas', nameHe: 'ספות', image: img('sofas') },
              { slug: 'rugs', nameHe: 'שטיחים', image: null },
            ],
          },
        ],
      },
      { id: 4, kind: 'products', titleHe: 'הנמכרים ביותר', items: [card('a'), card('b')], link: null },
      { id: 5, kind: 'products', titleHe: 'חדש באתר', items: [card('c')], link: null },
    ]);
    expect(el.querySelector('h1')?.textContent).toContain('בית שמרגיש');
    const ctas = [...el.querySelectorAll('.ctas a')].map((a) => a.textContent?.trim());
    expect(ctas).toEqual(['לכל הספות', 'קנייה לפי חדר']);
    const heroImg = el.querySelector('.hero-art img');
    expect(heroImg?.getAttribute('loading')).toBe('eager');
    expect(heroImg?.getAttribute('fetchpriority')).toBe('high');
    expect(el.querySelector('.hero-art source')?.getAttribute('sizes')).toBe('(width >= 1024px) 55vw, 100vw');
    expect(el.querySelectorAll('.trust li')).toHaveLength(3);
    expect(el.querySelector('#room-living-room')?.textContent).toBe('סלון');
    expect(el.querySelectorAll('.types li')).toHaveLength(2);
    expect(el.querySelector('.types source')?.getAttribute('sizes')).toBe('(width >= 1024px) 16vw, 42vw');
    const heads = [...el.querySelectorAll('h2')].map((h) => h.textContent);
    expect(heads).toEqual(['סלון', 'הנמכרים ביותר', 'חדש באתר']);
    expect(el.querySelectorAll('hg-product-card')).toHaveLength(3);
  });

  it('shows a live banner as the hero with a mobile source, alt text, priority and the CTA', async () => {
    const el = await render([hero(banner())]);
    expect(el.querySelector('h1')?.textContent).toBe('מבצע קיץ');
    expect(el.querySelector('.lead-text')?.textContent).toBe('עד 30 אחוז');
    const cta = el.querySelector('.ctas a');
    expect(cta?.textContent?.trim()).toBe('לקולקציה');
    expect(cta?.getAttribute('href')).toBe('/category/sofas');
    const mobile = el.querySelector('picture source[media="(width < 768px)"]');
    expect(mobile?.getAttribute('srcset')).toContain('mob');
    expect(el.querySelector('.banner-art')?.classList.contains('has-mobile')).toBe(true);
    const image = el.querySelector('picture img');
    expect(image?.getAttribute('alt')).toBe('באנר קיץ');
    expect(image?.getAttribute('loading')).toBe('eager');
  });

  it('makes the banner image the link when there is no button label (one link per banner)', async () => {
    const el = await render([hero(banner({ ctaLabelHe: null }))]);
    expect(el.querySelector('.ctas')).toBeNull();
    const links = el.querySelectorAll('.hero a');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe('/category/sofas');
    expect(links[0].querySelector('img')?.getAttribute('alt')).toBe('באנר קיץ');
  });

  it('shows only the first hero section', async () => {
    const el = await render([hero(banner()), { ...hero(banner({ headlineHe: 'שני' })), id: 9 }]);
    expect(el.querySelectorAll('h1')).toHaveLength(1);
    expect(el.querySelector('h1')?.textContent).toBe('מבצע קיץ');
  });

  it('opens an external banner link in the same tab with rel noopener, and omits a missing mobile source', async () => {
    const el = await render([hero(banner({ linkUrl: 'https://example.com/x', mobileImage: null }))]);
    const cta = el.querySelector('.ctas a');
    expect(cta?.getAttribute('href')).toBe('https://example.com/x');
    expect(cta?.getAttribute('rel')).toBe('noopener');
    expect(cta?.getAttribute('target')).toBeNull();
    expect(el.querySelector('picture source[media]')).toBeNull();
    expect(el.querySelector('.banner-art')?.classList.contains('has-mobile')).toBe(false);
  });

  it('renders category tiles, a product row with its link, and a banner pair (one banner: full width)', async () => {
    const el = await render([
      {
        id: 6,
        kind: 'categories',
        titleHe: 'סוגי רהיטים',
        categories: [
          { slug: 'sofas', nameHe: 'ספות', image: img('s') },
          { slug: 'tables', nameHe: 'שולחנות', image: null },
        ],
      },
      { id: 7, kind: 'products', titleHe: 'ספות', items: [card('a')], link: '/category/sofas' },
      { id: 8, kind: 'banner_pair', titleHe: null, banners: [banner({ id: 2 })] },
    ]);
    expect(el.querySelector('#sec-6')?.textContent).toBe('סוגי רהיטים');
    expect([...el.querySelectorAll('.types a')].map((a) => a.getAttribute('href'))).toEqual([
      '/category/sofas',
      '/category/tables',
    ]);
    const all = [...el.querySelectorAll('.section-head a')].find((a) => a.textContent === 'לכל המוצרים');
    expect(all?.getAttribute('href')).toBe('/category/sofas');
    expect(el.querySelector('.pair.single')).toBeTruthy();
    expect(el.querySelector('.pair a.card')?.getAttribute('href')).toBe('/category/sofas');
    expect(el.querySelector('.pair .headline')?.textContent).toBe('מבצע קיץ');
  });

  it('answers 503 (serverError) and shows a retry when the home fails to load', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const serverError = vi.spyOn(TestBed.inject(PageMeta), 'serverError');
    const fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    TestBed.inject(HttpTestingController)
      .expectOne('/api/content/home')
      .flush({}, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(serverError).toHaveBeenCalled();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[role="alert"]')).toBeTruthy();
    expect(root.querySelector('h1')?.textContent).toBe('לא הצלחנו לטעון את הדף');
  });
});
