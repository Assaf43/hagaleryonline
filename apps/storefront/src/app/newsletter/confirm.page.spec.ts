import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { CONSENT_TEXT_HE } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { NewsletterConfirmPage } from './confirm.page';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const PREVIEW = '/api/newsletter/confirm/preview';
const CONFIRM = '/api/newsletter/confirm';

describe('NewsletterConfirmPage', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<NewsletterConfirmPage>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const settle = async () => {
    await tick();
    fixture.detectChanges();
    await fixture.whenStable();
  };
  const confirmButton = () => el().querySelector<HTMLButtonElement>('button.confirm');

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
  /** Opens the page and answers the preview: the page then asks for the click. */
  async function openAsking(t = 'tok') {
    await open(t);
    http.expectOne(PREVIEW).flush({ email: 'd***@example.com' });
    await settle();
  }
  afterEach(() => http.verify());

  it('is noindex and shows no address before the browser answers', async () => {
    const set = await open('tok');
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(text()).not.toContain('@');
    http.expectOne(PREVIEW).flush({ email: 'd***@example.com' });
  });

  it('on load only previews: shows the masked address, the consent text and a button; nothing is confirmed without a click', async () => {
    await open('tok123');
    const req = http.expectOne(PREVIEW);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ token: 'tok123' });
    req.flush({ email: 'd***@example.com' });
    await settle();
    http.expectNone(CONFIRM);
    const bdi = el().querySelector('bdi');
    expect(bdi?.textContent).toBe('d***@example.com');
    expect(bdi?.getAttribute('dir')).toBe('ltr');
    expect(text()).toContain(CONSENT_TEXT_HE);
    expect(confirmButton()?.textContent).toContain('אישור ההרשמה');
    expect(text()).not.toContain('ההרשמה לדיוור אושרה');
  });

  it('the click confirms the token and shows the confirmed address', async () => {
    await openAsking('tok123');
    confirmButton()!.click();
    const req = http.expectOne(CONFIRM);
    expect(req.request.body).toEqual({ token: 'tok123' });
    req.flush({ email: 'd***@example.com' });
    await settle();
    expect(text()).toContain('ההרשמה לדיוור אושרה');
    expect(el().querySelector('bdi')?.textContent).toBe('d***@example.com');
  });

  it('a 404 on the preview shows the invalid or expired link text', async () => {
    await open('bad');
    http.expectOne(PREVIEW).flush({ code: 'link_invalid' }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(text()).toContain('הקישור לא תקין או שפג תוקפו');
    expect(confirmButton()).toBeNull();
  });

  it('a 404 on the confirm (used meanwhile) shows the invalid or expired link text', async () => {
    await openAsking();
    confirmButton()!.click();
    http.expectOne(CONFIRM).flush({ code: 'link_invalid' }, { status: 404, statusText: 'Not Found' });
    await settle();
    expect(text()).toContain('הקישור לא תקין או שפג תוקפו');
  });

  it('moves the focus to the heading when the state changes (announced to screen readers)', async () => {
    await open('tok');
    document.body.appendChild(el());
    http.expectOne(PREVIEW).flush({ email: 'd***@example.com' });
    await settle();
    expect(document.activeElement).toBe(el().querySelector('h1'));
    confirmButton()!.click();
    http.expectOne(CONFIRM).flush({ email: 'd***@example.com' });
    await settle();
    expect(text()).toContain('ההרשמה לדיוור אושרה');
    expect(document.activeElement).toBe(el().querySelector('h1'));
    el().remove();
  });

  it('a 5xx, 429 or network error on the preview is not "invalid link": the retry previews again', async () => {
    for (const status of [500, 429, 0]) {
      TestBed.resetTestingModule();
      await open('tok');
      const req = http.expectOne(PREVIEW);
      if (status === 0) req.error(new ProgressEvent('error'));
      else req.flush({}, { status, statusText: 'Error' });
      await settle();
      expect(text()).toContain('משהו השתבש. נסו שוב.');
      expect(text()).not.toContain('הקישור לא תקין');
      el().querySelector<HTMLButtonElement>('button.retry')!.click();
      http.expectOne(PREVIEW).flush({ email: 'd***@example.com' });
      await settle();
      http.expectNone(CONFIRM);
      expect(confirmButton()).not.toBeNull();
    }
  });

  it('a transient error on the confirm offers a retry that confirms again', async () => {
    await openAsking();
    confirmButton()!.click();
    http.expectOne(CONFIRM).flush({}, { status: 503, statusText: 'Error' });
    await settle();
    expect(text()).toContain('משהו השתבש. נסו שוב.');
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    http.expectOne(CONFIRM).flush({ email: 'd***@example.com' });
    await settle();
    expect(text()).toContain('ההרשמה לדיוור אושרה');
  });

  it('a missing token is an invalid link without a request', async () => {
    await open();
    fixture.detectChanges();
    expect(text()).toContain('הקישור לא תקין או שפג תוקפו');
    http.expectNone(PREVIEW);
    http.expectNone(CONFIRM);
  });
});
