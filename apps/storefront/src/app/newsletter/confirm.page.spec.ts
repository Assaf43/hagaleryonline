import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { NewsletterConfirmPage } from './confirm.page';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('NewsletterConfirmPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<NewsletterConfirmPage>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';

  async function open(t?: string) {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])],
    });
    http = TestBed.inject(HttpTestingController);
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(NewsletterConfirmPage);
    if (t !== undefined) fixture.componentRef.setInput('t', t);
    fixture.detectChanges();
    await fixture.whenStable();
    return set;
  }
  afterEach(() => http.verify());

  it('is noindex and shows no address before the browser answers', async () => {
    const set = await open('tok');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(text()).not.toContain('@');
    http.expectOne('/api/newsletter/confirm').flush({ email: 'd***@example.com' });
  });

  it('confirms the token and shows the masked address', async () => {
    await open('tok123');
    const req = http.expectOne('/api/newsletter/confirm');
    expect(req.request.body).toEqual({ token: 'tok123' });
    req.flush({ email: 'd***@example.com' });
    await tick();
    fixture.detectChanges();
    expect(text()).toContain('ההרשמה לדיוור אושרה');
    expect(el().querySelector('bdi')?.textContent).toBe('d***@example.com');
  });

  it('a 404 shows the invalid or expired link text', async () => {
    await open('bad');
    http.expectOne('/api/newsletter/confirm').flush({ code: 'link_invalid' }, { status: 404, statusText: 'Not Found' });
    await tick();
    fixture.detectChanges();
    expect(text()).toContain('הקישור לא תקין או שפג תוקפו');
  });

  it('a missing token is an invalid link without a request', async () => {
    await open();
    fixture.detectChanges();
    expect(text()).toContain('הקישור לא תקין או שפג תוקפו');
    http.expectNone('/api/newsletter/confirm');
  });
});
