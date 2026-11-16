import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import type { AccountConsent } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { ConsentPage } from './consent.page';
import { customerMe, failWith, provideAccountTesting, signedIn, tick, flushCarts } from './account.testing';

const consentOf = (over: Partial<AccountConsent> = {}): AccountConsent => ({
  status: null,
  source: null,
  consentAt: null,
  emailVerified: true,
  ...over,
});

describe('ConsentPage', () => {
  let fixture: ComponentFixture<ConsentPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const box = () => el().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  /** Opens the page; the contact state comes from GET /api/account/consent. */
  async function setup(consent: AccountConsent) {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore), customerMe());
    fixture = TestBed.createComponent(ConsentPage);
    fixture.detectChanges();
    http.expectOne('/api/account/consent').flush(consent);
    await settle();
  }

  afterEach(() => http.verify());

  it('is noindex, with a labelled checkbox that follows the contact', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore), customerMe());
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(ConsentPage);
    fixture.detectChanges();
    http.expectOne('/api/account/consent').flush(consentOf({ status: 'subscribed', source: 'account' }));
    await settle();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(box().checked).toBe(true);
    expect(box().closest('label')?.textContent).toContain('דיוור');
  });

  it('is unchecked when the e-mail has no contact or it is unsubscribed', async () => {
    await setup(consentOf({ status: null }));
    expect(box().checked).toBe(false);
  });

  it('is unchecked for an unsubscribed contact', async () => {
    await setup(consentOf({ status: 'unsubscribed', source: 'newsletter' }));
    expect(box().checked).toBe(false);
  });

  it('a pending contact says it waits for the link (whatever channel sent it) and can be cancelled with PUT false', async () => {
    await setup(consentOf({ status: 'pending', source: 'checkout' }));
    expect(text()).toContain('ממתין לאישור דרך הקישור ששלחנו');
    expect(text()).not.toContain('במייל');
    expect(box()).toBeNull();
    el().querySelector<HTMLButtonElement>('button.cancel-pending')!.click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ marketingConsent: false });
    req.flush(consentOf({ status: 'unsubscribed', source: 'checkout' }));
    await settle();
    expect(text()).not.toContain('ממתין לאישור');
    expect(box().checked).toBe(false);
    expect(el().querySelector('[role="status"]')?.textContent).toContain('בוטלה');
  });

  it('an unverified e-mail shows the verify prompt instead of the toggle', async () => {
    await setup(consentOf({ emailVerified: false }));
    expect(box()).toBeNull();
    expect(text()).toContain('כדי לקבל דיוור יש לאמת קודם את כתובת הדוא״ל');
    expect(el().querySelector('a.verify-link')?.textContent).toContain('אימות הדוא״ל');
  });

  it('unverified + subscribed shows the withdraw control: unticking saves false, then the verify prompt', async () => {
    // A store quick account (decision 96) can be subscribed with an e-mail it never verified.
    await setup(consentOf({ status: 'subscribed', source: 'store', emailVerified: false }));
    expect(box().checked).toBe(true);
    expect(text()).not.toContain('כדי לקבל דיוור יש לאמת קודם');
    box().click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.body).toEqual({ marketingConsent: false });
    req.flush(consentOf({ status: 'unsubscribed', source: 'store', emailVerified: false }));
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('בוטלה');
    // Giving consent again needs a verified e-mail.
    expect(box()).toBeNull();
    expect(text()).toContain('כדי לקבל דיוור יש לאמת קודם את כתובת הדוא״ל');
  });

  it('unverified + pending shows cancel', async () => {
    await setup(consentOf({ status: 'pending', source: 'store', emailVerified: false }));
    expect(text()).toContain('ממתין לאישור דרך הקישור ששלחנו');
    expect(text()).not.toContain('כדי לקבל דיוור יש לאמת קודם');
    el().querySelector<HTMLButtonElement>('button.cancel-pending')!.click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.body).toEqual({ marketingConsent: false });
    req.flush(consentOf({ status: 'unsubscribed', source: 'store', emailVerified: false }));
    await settle();
    expect(el().querySelector('[role="status"]')?.textContent).toContain('בוטלה');
  });

  it('giving consent saves at once and says so', async () => {
    await setup(consentOf());
    box().click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ marketingConsent: true });
    req.flush(consentOf({ status: 'subscribed', source: 'account', consentAt: '2026-11-12T10:00:00.000Z' }));
    await settle();
    expect(TestBed.inject(CustomerStore).me()?.marketingConsent).toBe(true);
    expect(el().querySelector('[role="status"]')?.textContent).toContain('נשמרה');
    expect(box().checked).toBe(true);
  });

  it('withdrawal is one click: unchecking saves false', async () => {
    await setup(consentOf({ status: 'subscribed', source: 'signup' }));
    box().click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.body).toEqual({ marketingConsent: false });
    req.flush(consentOf({ status: 'unsubscribed', source: 'signup' }));
    await settle();
    expect(TestBed.inject(CustomerStore).me()?.marketingConsent).toBe(false);
    expect(box().checked).toBe(false);
    expect(el().querySelector('[role="status"]')?.textContent).toContain('בוטלה');
    // There is no withdrawal time to show, so the old "ההסכמה בוטלה ב־" line stays gone.
    expect(text()).not.toContain('ההסכמה בוטלה ב');
  });

  it('the checkbox is never disabled while saving (the focus stays on it)', async () => {
    await setup(consentOf());
    box().focus();
    box().click();
    fixture.detectChanges();
    expect(box().disabled).toBe(false);
    expect(document.activeElement).toBe(box());
    http
      .expectOne('/api/account/consent')
      .flush(consentOf({ status: 'subscribed', source: 'account', consentAt: '2026-11-12T10:00:00.000Z' }));
    await settle();
  });

  it('shows the consent date of a subscribed contact', async () => {
    await setup(consentOf({ status: 'subscribed', source: 'account', consentAt: '2026-11-12T10:00:00.000Z' }));
    expect(text()).toContain('12.11.2026');
  });

  it('a signed-out answer (401) clears the customer and goes to sign-in with ?next=', async () => {
    await setup(consentOf());
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    box().click();
    failWith(http.expectOne('/api/account/consent'), 401, 'not_authenticated');
    await settle();
    expect(TestBed.inject(CustomerStore).me()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/account'], { queryParams: { next: expect.any(String) } });
    flushCarts(http);
  });

  it('a failed save restores the checkbox and shows an alert', async () => {
    await setup(consentOf());
    box().click();
    failWith(http.expectOne('/api/account/consent'), 429, 'too_many_requests');
    await settle();
    expect(box().checked).toBe(false);
    const alerts = [...el().querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
    expect(alerts).toContain('ביצעתם יותר מדי ניסיונות');
  });

  it('a 409 email_not_verified switches to the verify prompt', async () => {
    await setup(consentOf());
    box().click();
    failWith(http.expectOne('/api/account/consent'), 409, 'email_not_verified');
    await settle();
    expect(box()).toBeNull();
    expect(text()).toContain('כדי לקבל דיוור יש לאמת קודם את כתובת הדוא״ל');
  });
});
