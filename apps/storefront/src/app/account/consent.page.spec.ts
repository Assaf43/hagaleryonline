import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { ConsentPage } from './consent.page';
import { customerMe, failWith, provideAccountTesting, signedIn, tick, flushCarts } from './account.testing';

describe('ConsentPage', () => {
  let fixture: ComponentFixture<ConsentPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const box = () => el().querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  async function setup(consent: boolean) {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore), customerMe({ marketingConsent: consent }));
    fixture = TestBed.createComponent(ConsentPage);
    fixture.detectChanges();
    await settle();
  }

  afterEach(() => http.verify());

  it('is noindex, with a labelled checkbox that follows the account', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore), customerMe({ marketingConsent: true }));
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(ConsentPage);
    fixture.detectChanges();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(box().checked).toBe(true);
    expect(box().closest('label')?.textContent).toContain('דיוור');
  });

  it('is unchecked when there is no consent', async () => {
    await setup(false);
    expect(box().checked).toBe(false);
  });

  it('giving consent saves at once and says so', async () => {
    await setup(false);
    box().click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ marketingConsent: true });
    req.flush({
      marketingConsent: true,
      marketingConsentAt: '2026-11-12T10:00:00.000Z',
      marketingConsentSource: 'account',
      marketingWithdrawnAt: null,
    });
    await settle();
    expect(TestBed.inject(CustomerStore).me()?.marketingConsent).toBe(true);
    expect(el().querySelector('[role="status"]')?.textContent).toContain('נשמרה');
    expect(box().checked).toBe(true);
  });

  it('withdrawal is one click: unchecking saves false', async () => {
    await setup(true);
    box().click();
    const req = http.expectOne('/api/account/consent');
    expect(req.request.body).toEqual({ marketingConsent: false });
    req.flush({
      marketingConsent: false,
      marketingConsentAt: '2026-11-12T10:00:00.000Z',
      marketingConsentSource: 'signup',
      marketingWithdrawnAt: '2026-11-13T10:00:00.000Z',
    });
    await settle();
    expect(TestBed.inject(CustomerStore).me()?.marketingConsent).toBe(false);
    expect(box().checked).toBe(false);
    expect(el().querySelector('[role="status"]')?.textContent).toContain('בוטלה');
  });

  it('the checkbox is never disabled while saving (the focus stays on it)', async () => {
    await setup(false);
    box().focus();
    box().click();
    fixture.detectChanges();
    expect(box().disabled).toBe(false);
    expect(document.activeElement).toBe(box());
    http.expectOne('/api/account/consent').flush({
      marketingConsent: true,
      marketingConsentAt: '2026-11-12T10:00:00.000Z',
      marketingConsentSource: 'account',
      marketingWithdrawnAt: null,
    });
    await settle();
  });

  it('shows the consent date from the first load (me.marketingConsentAt)', async () => {
    http = provideAccountTesting();
    signedIn(
      TestBed.inject(CustomerStore),
      customerMe({ marketingConsent: true, marketingConsentAt: '2026-11-12T10:00:00.000Z' }),
    );
    fixture = TestBed.createComponent(ConsentPage);
    fixture.detectChanges();
    expect(el().textContent).toContain('12.11.2026');
  });

  it('a signed-out answer (401) clears the customer and goes to sign-in with ?next=', async () => {
    await setup(false);
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    box().click();
    failWith(http.expectOne('/api/account/consent'), 401, 'not_authenticated');
    await settle();
    expect(TestBed.inject(CustomerStore).me()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/account'], { queryParams: { next: expect.any(String) } });
    flushCarts(http);
  });

  it('a failed save restores the checkbox and shows an alert', async () => {
    await setup(false);
    box().click();
    failWith(http.expectOne('/api/account/consent'), 429, 'too_many_requests');
    await settle();
    expect(box().checked).toBe(false);
    const alerts = [...el().querySelectorAll('[role="alert"]')].map((a) => a.textContent).join(' ');
    expect(alerts).toContain('ביצעתם יותר מדי ניסיונות');
  });
});
