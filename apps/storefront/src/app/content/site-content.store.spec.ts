import { TestBed } from '@angular/core/testing';
import { REQUEST } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { SiteContentView } from '@hg/models';
import { SiteContentStore, readClosedAnnouncement } from './site-content.store';

const site = (version = 1): SiteContentView => ({
  supportPhone: '03-1',
  supportEmail: 'a@b.test',
  whatsapp: '9725',
  shippingHtml: '<p>x</p>',
  announcement: { id: 4, version, textHe: 'מבצע', linkUrl: null, linkLabelHe: null },
  footerPages: [{ slug: 'terms', labelHe: 'תקנון' }],
});

const clearCookie = () => {
  document.cookie = 'hg-ann=; Max-Age=0; Path=/';
};

describe('SiteContentStore', () => {
  beforeEach(() => {
    clearCookie();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  });
  afterEach(clearCookie);

  it('loads the site once', async () => {
    const store = TestBed.inject(SiteContentStore);
    const http = TestBed.inject(HttpTestingController);
    const first = store.load();
    const second = store.load();
    http.expectOne('/api/content/site').flush(site());
    await Promise.all([first, second]);
    expect(store.contact().phone).toBe('03-1');
    expect(store.footerPages()).toHaveLength(1);
    expect(store.announcement()?.textHe).toBe('מבצע');
    http.verify();
  });

  it('closing hides the bar and writes hg-ann; a new version shows it again', async () => {
    const store = TestBed.inject(SiteContentStore);
    const http = TestBed.inject(HttpTestingController);
    const loading = store.load();
    http.expectOne('/api/content/site').flush(site(1));
    await loading;
    store.close(store.announcement()!);
    expect(store.announcement()).toBeNull();
    expect(document.cookie).toContain('hg-ann=4:1');
    store.site.set(site(2));
    expect(store.announcement()?.version).toBe(2);
  });

  it('closed bar reappears on new version (the old cookie does not match)', () => {
    document.cookie = 'hg-ann=4:1; Path=/';
    const store = TestBed.inject(SiteContentStore);
    store.site.set(site(1));
    expect(store.announcement()).toBeNull();
    store.site.set(site(2));
    expect(store.announcement()).not.toBeNull();
  });

  it('is hidden when the SSR request cookie matches', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: REQUEST, useValue: new Request('http://x/', { headers: { cookie: 'a=1; hg-ann=4:1' } }) },
      ],
    });
    const store = TestBed.inject(SiteContentStore);
    store.site.set(site(1));
    expect(store.announcement()).toBeNull();
  });
});

describe('readClosedAnnouncement', () => {
  it('reads id:version and ignores junk', () => {
    expect(readClosedAnnouncement('a=1; hg-ann=12:3; b=2')).toBe('12:3');
    expect(readClosedAnnouncement('hg-ann=x')).toBeNull();
    expect(readClosedAnnouncement(null)).toBeNull();
  });
});
