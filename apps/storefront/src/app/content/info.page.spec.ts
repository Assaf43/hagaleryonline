import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { InfoPage } from './info.page';

describe('InfoPage', () => {
  function open(slug: string) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const meta = TestBed.inject(PageMeta);
    const set = vi.spyOn(meta, 'set');
    const notFound = vi.spyOn(meta, 'notFound');
    const fixture = TestBed.createComponent(InfoPage);
    fixture.componentRef.setInput('slug', slug);
    fixture.detectChanges();
    return { fixture, http: TestBed.inject(HttpTestingController), set, notFound };
  }
  const settle = async (f: { detectChanges(): void; whenStable(): Promise<unknown> }) => {
    await f.whenStable();
    f.detectChanges();
    await f.whenStable();
    f.detectChanges();
  };

  it('renders title, body and the update date, with the page noindex flag', async () => {
    const { fixture, http, set } = open('shipping');
    http.expectOne('/api/content/pages/shipping').flush({
      slug: 'shipping',
      titleHe: 'משלוחים',
      bodyHtml: '<p>טקסט</p>',
      metaDescriptionHe: null,
      noindex: true,
      updatedAt: '2026-11-05T10:00:00.000Z',
    });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toBe('משלוחים');
    expect(el.querySelector('hg-rich-text p')?.textContent).toBe('טקסט');
    expect(el.querySelector('.updated bdi')?.textContent).toBe('05.11.2026');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ path: '/info/shipping', noindex: true }));
  });

  it('answers 404 for an unknown page', async () => {
    const { fixture, http, notFound } = open('nope');
    http.expectOne('/api/content/pages/nope').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await settle(fixture);
    expect(notFound).toHaveBeenCalled();
    expect((fixture.nativeElement as HTMLElement).querySelector('h1')?.textContent).toBe('הדף לא נמצא');
  });
});
