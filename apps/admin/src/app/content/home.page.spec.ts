import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminBanner, AdminHome } from '@hg/models';
import { BannersPage } from './banners.page';
import { HomePage } from './home.page';

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve, 0));
  fixture.detectChanges();
};

const NONE = { bannerIds: [], categoryIds: [], productIds: [], source: false };

const HOME: AdminHome = {
  updatedAt: '2026-11-17T10:00:00.000Z',
  sections: [
    { id: 1, kind: 'hero', bannerIds: [3], titleHe: null, visible: true, unavailable: { ...NONE, bannerIds: [3] } },
    { id: 2, kind: 'trust', titleHe: null, visible: true, unavailable: NONE },
    {
      id: 4,
      kind: 'products',
      source: { kind: 'bestsellers' },
      count: 4,
      titleHe: 'הנמכרים ביותר',
      visible: true,
      unavailable: NONE,
    },
  ],
};

const BANNER = {
  id: 3,
  nameHe: 'מבצע חורף',
  headlineHe: 'מבצע החורף',
  sublineHe: null,
  ctaLabelHe: null,
  linkUrl: '/x',
  imageId: 1,
  image: { url: '/media/content/a.webp', altHe: '' },
  mobileImageId: null,
  mobileImage: null,
  altHe: 'א',
  active: true,
  startsAt: null,
  endsAt: null,
  createdAt: '2026-11-17T10:00:00.000Z',
  updatedAt: '2026-11-17T10:00:00.000Z',
} satisfies AdminBanner;

describe('admin home page screen', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(home: AdminHome = HOME) {
    const fixture = TestBed.createComponent(HomePage);
    fixture.detectChanges();
    http.expectOne('/api/admin/content/home').flush(home);
    http.expectOne('/api/admin/content/banners').flush([BANNER]);
    http.expectOne('/api/admin/catalog/structure').flush({ categories: [], rooms: [], attributes: [], synonyms: [] });
    http.expectOne('/api/admin/content/promotion-sources').flush([]);
    http.expectNone('/api/admin/promotions');
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  const names = (el: HTMLElement) => [...el.querySelectorAll('.section .name')].map((n) => n.textContent?.trim());

  it('lists the sections in order with a summary and marks what the site cannot show', async () => {
    const { el } = await open();
    expect(names(el)).toEqual(['באנר ראשי', 'שורת יתרונות', 'הנמכרים ביותר']);
    const first = el.querySelector('.section')!;
    expect(first.querySelector('.meta')?.textContent).toContain('מבצע חורף');
    expect(first.querySelector('.mark')?.textContent).toContain('לא מוצג באתר');
    expect(el.querySelectorAll('.section .mark')).toHaveLength(1);
  });

  it('moves a section down and up, with the ends disabled', async () => {
    const { fixture, el } = await open();
    const rows = () => [...el.querySelectorAll('.section')];
    expect((rows()[0].querySelector('.up') as HTMLButtonElement).disabled).toBe(true);
    expect((rows()[2].querySelector('.down') as HTMLButtonElement).disabled).toBe(true);
    (rows()[0].querySelector('.down') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(names(el)).toEqual(['שורת יתרונות', 'באנר ראשי', 'הנמכרים ביותר']);
    (rows()[1].querySelector('.up') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(names(el)).toEqual(['באנר ראשי', 'שורת יתרונות', 'הנמכרים ביותר']);
  });

  it('saves the whole list once, in order, with the version it was opened at', async () => {
    const { fixture, el } = await open();
    (el.querySelectorAll('.section')[1].querySelector('.up') as HTMLButtonElement).click();
    (el.querySelectorAll('.section')[2].querySelector('input[type="checkbox"]') as HTMLInputElement).click();
    fixture.detectChanges();
    void fixture.componentInstance.save();
    const req = http.expectOne({ method: 'PUT', url: '/api/admin/content/home' });
    expect(req.request.body.expectedUpdatedAt).toBe(HOME.updatedAt);
    expect(req.request.body.sections.map((s: { id: number }) => s.id)).toEqual([2, 1, 4]);
    expect(req.request.body.sections[2].visible).toBe(false);
    expect(req.request.body.sections[1]).toEqual({ id: 1, kind: 'hero', bannerIds: [3], titleHe: null, visible: true });
    req.flush({ ...HOME, updatedAt: '2026-11-17T11:00:00.000Z' });
    await settle(fixture);
    expect(fixture.componentInstance.canLeave()).toBe(true);
  });

  it('removes a section after a confirm and sends the shorter list', async () => {
    const { fixture, el } = await open();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (el.querySelectorAll('.section')[1].querySelector('.remove') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(names(el)).toEqual(['באנר ראשי', 'הנמכרים ביותר']);
    void fixture.componentInstance.save();
    const req = http.expectOne({ method: 'PUT', url: '/api/admin/content/home' });
    expect(req.request.body.sections).toHaveLength(2);
    req.flush(HOME);
    await settle(fixture);
  });

  it('shows a conflict in Hebrew and keeps the edits', async () => {
    const { fixture, el } = await open();
    (el.querySelectorAll('.section')[0].querySelector('.down') as HTMLButtonElement).click();
    fixture.detectChanges();
    void fixture.componentInstance.save();
    http
      .expectOne({ method: 'PUT', url: '/api/admin/content/home' })
      .flush({ code: 'conflict' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('.form-error')?.textContent).toContain('מישהו אחר שמר');
    expect(names(el)[0]).toBe('שורת יתרונות');
  });

  it('refuses an empty list before sending', async () => {
    const { fixture, el } = await open({ ...HOME, sections: [HOME.sections[1]] });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    (el.querySelector('.section .remove') as HTMLButtonElement).click();
    fixture.detectChanges();
    await fixture.componentInstance.save();
    fixture.detectChanges();
    expect(el.querySelector('.form-error')?.textContent).toContain('אזור אחד');
  });
});

describe('admin banners list', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('names the home sections when a banner in use is deleted', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const fixture = TestBed.createComponent(BannersPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/content/banners').flush([BANNER]);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.name')?.textContent).toContain('מבצע חורף');
    (el.querySelector('.row-actions button') as HTMLButtonElement).click();
    http
      .expectOne({ method: 'DELETE', url: '/api/admin/content/banners/3' })
      .flush({ code: 'banner_in_use', sections: ['באנר ראשי'] }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('.form-error')?.textContent).toContain('"באנר ראשי"');
    expect(el.querySelectorAll('.row')).toHaveLength(1);
  });
});
