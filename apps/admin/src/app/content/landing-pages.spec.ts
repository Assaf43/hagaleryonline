import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminLandingPage } from '@hg/models';
import { LandingFormPage } from './landing-form.page';
import { LandingPagesPage } from './landing-pages.page';

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
};

const PAGE: AdminLandingPage = {
  id: 4,
  slug: 'winter-sale',
  titleHe: 'מבצע חורף',
  sublineHe: null,
  introHtml: '<p>חם בסלון</p>',
  outroHtml: null,
  imageId: 1,
  image: { url: '/media/content/a.webp', altHe: '' },
  mobileImageId: null,
  mobileImage: null,
  altHe: 'ספה',
  source: { kind: 'category', id: 2 },
  status: 'published',
  state: 'live',
  startsAt: null,
  endsAt: null,
  endedLinkUrl: '/',
  metaDescriptionHe: null,
  noindex: false,
  unavailable: { productIds: [], source: false },
  sourceLink: '/category/sofas',
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
};

describe('admin landing pages', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    http.verify();
  });

  it('lists pages with address, state and dates', async () => {
    const fixture = TestBed.createComponent(LandingPagesPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/content/landing').flush([PAGE, { ...PAGE, id: 5, slug: 'old', state: 'ended' }]);
    await settle(fixture);
    const rows = (fixture.nativeElement as HTMLElement).querySelectorAll('.row');
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('/collection/winter-sale');
    expect(rows[0].textContent).toContain('פעיל');
    expect(rows[1].textContent).toContain('הסתיים');
  });

  describe('form', () => {
    async function open(id: string, page: AdminLandingPage | null = PAGE) {
      const fixture = TestBed.createComponent(LandingFormPage);
      fixture.componentRef.setInput('id', id);
      fixture.detectChanges();
      await fixture.whenStable();
      http.expectOne('/api/admin/catalog/structure').flush({
        categories: [{ id: 2, nameHe: 'ספות', parentId: null, active: true }],
        rooms: [],
        attributes: [],
        synonyms: [],
      });
      http.expectOne('/api/admin/content/promotion-sources').flush([]);
      if (page) http.expectOne(`/api/admin/content/landing/${page.id}`).flush(page);
      await settle(fixture);
      return fixture;
    }

    it('has no preview button on a new page', async () => {
      const fixture = await open('new', null);
      expect((fixture.nativeElement as HTMLElement).querySelector('.preview')).toBeNull();
    });

    it('opens the signed preview in a new tab and cuts the opener link', async () => {
      const fixture = await open('4');
      const tab = { opener: {} } as unknown as Window;
      const spy = vi.spyOn(window, 'open').mockReturnValue(tab);
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.preview')!.click();
      http.expectOne('/api/admin/content/landing/4/preview').flush({
        url: 'http://localhost:4200/collection/winter-sale?preview=4.1.x',
        expiresAt: '2026-11-18T10:30:00Z',
      });
      await settle(fixture);
      expect(spy).toHaveBeenCalledWith('http://localhost:4200/collection/winter-sale?preview=4.1.x', '_blank');
      expect(tab.opener).toBeNull();
      expect((fixture.nativeElement as HTMLElement).querySelector('.open-preview')).toBeNull();
    });

    it('shows a link button when the tab is blocked', async () => {
      const fixture = await open('4');
      vi.spyOn(window, 'open').mockReturnValue(null);
      (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.preview')!.click();
      http
        .expectOne('/api/admin/content/landing/4/preview')
        .flush({ url: 'http://localhost:4200/c?preview=1', expiresAt: 'x' });
      await settle(fixture);
      const link = (fixture.nativeElement as HTMLElement).querySelector<HTMLAnchorElement>('.open-preview')!;
      expect(link.getAttribute('href')).toBe('http://localhost:4200/c?preview=1');
      expect(link.rel).toContain('noopener');
      expect(link.target).toBe('_blank');
    });

    it('offers the source category as the ended-link shortcut', async () => {
      const fixture = await open('4');
      const el = fixture.nativeElement as HTMLElement;
      const shortcut = el.querySelector<HTMLButtonElement>('.to-source')!;
      expect(shortcut.textContent).toContain('קטגוריית המקור');
      shortcut.click();
      await settle(fixture);
      expect(el.querySelector<HTMLInputElement>('#landing-ended-link')!.value).toBe('/category/sofas');
    });

    it('has no source shortcut when the page has none', async () => {
      const fixture = await open('4', { ...PAGE, source: { kind: 'bestsellers' }, sourceLink: null });
      expect((fixture.nativeElement as HTMLElement).querySelector('.to-source')).toBeNull();
    });
  });
});
