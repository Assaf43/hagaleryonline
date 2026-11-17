import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminInfoPage } from '@hg/models';
import { InfoPageFormPage } from './info-page-form.page';

const PAGE: AdminInfoPage = {
  id: 4,
  slug: 'terms',
  systemKey: 'terms',
  titleHe: 'תקנון',
  bodyHtml: '<p>טקסט</p>',
  metaDescriptionHe: null,
  published: true,
  noindex: false,
  showInFooter: true,
  footerLabelHe: null,
  footerOrder: 1,
  interim: true,
  createdAt: '2026-11-01T10:00:00.000Z',
  updatedAt: '2026-11-01T10:00:00.000Z',
};

describe('info page form', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(id: string, page: AdminInfoPage | null) {
    const fixture = TestBed.createComponent(InfoPageFormPage);
    fixture.componentRef.setInput('id', id);
    fixture.detectChanges();
    if (page) http.expectOne(`/api/admin/content/pages/${page.id}`).flush(page);
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('locks the slug and the publish switch of a system page and says why', async () => {
    const { el } = await open('4', PAGE);
    expect(el.querySelector<HTMLInputElement>('#page-slug')?.readOnly).toBe(true);
    const published = el.querySelector<HTMLInputElement>('#page-published');
    expect(published?.disabled).toBe(true);
    expect(published?.checked).toBe(true);
    expect(el.textContent).toContain('עמוד מערכת: תמיד מפורסם');
    expect(el.textContent).toContain('טקסט זמני');
  });

  it('leaves them open on a new or ordinary page', async () => {
    const { el } = await open('new', null);
    expect(el.querySelector<HTMLInputElement>('#page-slug')?.readOnly).toBe(false);
    expect(el.querySelector<HTMLInputElement>('#page-published')?.disabled).toBe(false);
    expect(el.textContent).not.toContain('עמוד מערכת: תמיד מפורסם');
  });

  it('saves with expectedUpdatedAt and keeps a system page published', async () => {
    const { fixture, el } = await open('4', PAGE);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    const req = http.expectOne({ method: 'PUT', url: '/api/admin/content/pages/4' });
    expect(req.request.body).toMatchObject({ slug: 'terms', published: true, expectedUpdatedAt: PAGE.updatedAt });
    req.flush({ ...PAGE, interim: false, updatedAt: '2026-11-02T10:00:00.000Z' });
    await fixture.whenStable();
  });

  it('shows the conflict message when someone saved first', async () => {
    const { fixture, el } = await open('4', PAGE);
    el.querySelector('form')!.dispatchEvent(new Event('submit'));
    http
      .expectOne({ method: 'PUT', url: '/api/admin/content/pages/4' })
      .flush({ code: 'conflict' }, { status: 409, statusText: 'Conflict' });
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.form-error')?.textContent).toContain('מישהו אחר שמר');
  });
});
