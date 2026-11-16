import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CONSENT_TEXT_HE } from '@hg/models';
import { NewsletterForm } from './newsletter-form';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

describe('NewsletterForm', () => {
  let fixture: ComponentFixture<NewsletterForm>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const email = () => el().querySelector<HTMLInputElement>('input[type="email"]')!;
  const consent = () => el().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const submit = () => el().querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };
  const type = (value: string) => {
    email().value = value;
    email().dispatchEvent(new Event('input'));
  };
  const create = () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(NewsletterForm);
    fixture.detectChanges();
  };

  beforeEach(create);
  afterEach(() => http.verify());

  it('has the shared consent text, unchecked, and a hidden honeypot', () => {
    expect(consent().checked).toBe(false);
    expect(consent().closest('label')?.textContent).toContain(CONSENT_TEXT_HE);
    const hp = el().querySelector<HTMLInputElement>('input[name="website"]')!;
    expect(hp.tabIndex).toBe(-1);
    expect(hp.getAttribute('autocomplete')).toBe('off');
    expect(hp.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('refuses a bad e-mail and a missing consent without calling the API', async () => {
    type('nope');
    submit().click();
    await settle();
    expect(el().textContent).toContain('יש להזין כתובת דוא״ל תקינה');
    type('a@example.com');
    submit().click();
    await settle();
    expect(el().textContent).toContain('יש לסמן את ההסכמה כדי להירשם');
    http.expectNone('/api/newsletter');
  });

  it('posts the address with consent and the honeypot, then shows one success text', async () => {
    type('  A@Example.com ');
    consent().click();
    submit().click();
    const req = http.expectOne('/api/newsletter');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'A@Example.com', consent: true, website: '' });
    req.flush({}, { status: 202, statusText: 'Accepted' });
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent?.trim()).toBe(
      'שלחנו קישור אישור למייל. ההרשמה תושלם אחרי האישור.',
    );
    expect(el().querySelector('form')).toBeNull();
  });

  it('shows the same success text for every 202 (no sign of an existing address)', async () => {
    const texts: string[] = [];
    for (const address of ['new@example.com', 'known@example.com']) {
      if (texts.length) {
        TestBed.resetTestingModule();
        create();
      }
      type(address);
      consent().click();
      submit().click();
      http.expectOne('/api/newsletter').flush({}, { status: 202, statusText: 'Accepted' });
      await settle();
      texts.push(el().querySelector('[role="status"]')?.textContent?.trim() ?? '');
    }
    expect(texts[0]).toBe(texts[1]);
    expect(texts[0]).not.toBe('');
  });

  it('a 429 reads "too many attempts" and the form stays', async () => {
    type('a@example.com');
    consent().click();
    submit().click();
    http.expectOne('/api/newsletter').flush({ statusCode: 429 }, { status: 429, statusText: 'Too Many' });
    await settle();
    expect(el().querySelector('[role="alert"]')?.textContent).toContain('ביצעתם יותר מדי ניסיונות');
    expect(el().querySelector('form')).not.toBeNull();
  });

  it('a 400 on the e-mail shows the field error', async () => {
    type('a@example.com');
    consent().click();
    submit().click();
    http
      .expectOne('/api/newsletter')
      .flush({ code: 'invalid_input', field: 'email' }, { status: 400, statusText: 'Bad Request' });
    await settle();
    expect(el().textContent).toContain('יש להזין כתובת דוא״ל תקינה');
  });
});
