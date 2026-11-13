import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { SignUpDraft } from './sign-up-draft';
import { SignUpPage } from './sign-up.page';
import { customerMe, failWith, flushCarts, pasteInto, provideAccountTesting, typeInto, tick } from './account.testing';

describe('SignUpPage', () => {
  let fixture: ComponentFixture<SignUpPage>;
  let http: HttpTestingController;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement>(sel: string) => el().querySelector<T>(sel)!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };
  const otp = (n: number) => el().querySelectorAll<HTMLInputElement>('hg-otp-field')[n].querySelector('input')!;

  async function setup(opts: { next?: string; draft?: Parameters<SignUpDraft['set']>[0] } = {}) {
    http = provideAccountTesting();
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    if (opts.draft) TestBed.inject(SignUpDraft).set(opts.draft);
    fixture = TestBed.createComponent(SignUpPage);
    if (opts.next !== undefined) fixture.componentRef.setInput('next', opts.next);
    fixture.detectChanges();
    http.expectOne('/api/account/me').flush(null);
    await settle();
  }

  function fillDetails(over: Partial<Record<'name' | 'phone' | 'email' | 'password', string>> = {}) {
    if (!q<HTMLInputElement>('#su-name').disabled) typeInto(q('#su-name'), over.name ?? 'דנה כהן');
    if (!q<HTMLInputElement>('#su-phone').readOnly) typeInto(q('#su-phone'), over.phone ?? '050-1234567');
    if (!q<HTMLInputElement>('#su-email').readOnly) typeInto(q('#su-email'), over.email ?? 'Dana@Example.com');
    if (over.password) typeInto(q('#su-password'), over.password);
  }
  const submit = () => q<HTMLButtonElement>('form.details-form button[type="submit"]').click();

  afterEach(() => http.verify());

  it('is noindex', async () => {
    http = provideAccountTesting();
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(SignUpPage);
    fixture.detectChanges();
    http.expectOne('/api/account/me').flush(null);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });

  it('has labelled fields and the consent checkbox unchecked', async () => {
    await setup();
    for (const id of ['su-name', 'su-phone', 'su-email', 'su-password']) {
      expect(el().querySelector(`label[for="${id}"]`)).not.toBeNull();
    }
    const consent = q<HTMLInputElement>('#su-consent');
    expect(consent.type).toBe('checkbox');
    expect(consent.checked).toBe(false);
  });

  it('validates the details before sending', async () => {
    await setup();
    submit();
    await settle();
    http.expectNone('/api/account/sign-up');
    for (const id of ['su-name', 'su-phone', 'su-email']) {
      const field = q(`#${id}`);
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(q(`#${field.getAttribute('aria-describedby')}`)).not.toBeNull();
    }
    fillDetails({ password: 'short' });
    submit();
    await settle();
    expect(q('#su-password').getAttribute('aria-invalid')).toBe('true');
    http.expectNone('/api/account/sign-up');
  });

  it('asks for a code on the phone and one on the e-mail, then creates the account once both are verified', async () => {
    await setup({ next: '/checkout' });
    fillDetails({ password: 'long-enough-pass' });
    q<HTMLInputElement>('#su-consent').click();
    submit();
    const first = http.expectOne('/api/account/sign-up');
    expect(first.request.body).toEqual({
      fullName: 'דנה כהן',
      phone: '0501234567',
      email: 'dana@example.com',
      password: 'long-enough-pass',
      marketingConsent: true,
    });
    first.flush({ verify: true });
    await settle();
    expect(el().querySelectorAll('hg-otp-field')).toHaveLength(2);

    pasteInto(otp(0), '111111');
    const phoneVerify = http.expectOne('/api/account/otp/verify');
    expect(phoneVerify.request.body).toEqual({ target: '0501234567', code: '111111', purpose: 'sign_up' });
    phoneVerify.flush({
      needsSignUp: true,
      signUpToken: 't-phone',
      verified: { phone: '0501234567', email: null },
    });
    await settle();
    http.expectNone('/api/account/sign-up');

    pasteInto(otp(1), '222222');
    const emailVerify = http.expectOne('/api/account/otp/verify');
    expect(emailVerify.request.body).toEqual({
      target: 'dana@example.com',
      code: '222222',
      purpose: 'sign_up',
      signUpToken: 't-phone',
    });
    emailVerify.flush({
      needsSignUp: true,
      signUpToken: 't-both',
      verified: { phone: '0501234567', email: 'dana@example.com' },
    });
    await settle();

    const final = http.expectOne('/api/account/sign-up');
    expect(final.request.body).toMatchObject({ signUpToken: 't-both', email: 'dana@example.com' });
    final.flush({ customer: customerMe() });
    await settle();
    expect(TestBed.inject(CustomerStore).me()).not.toBeNull();
    expect(navigateByUrl).toHaveBeenCalledWith('/checkout');
    flushCarts(http);
  });

  it('a taken phone (409) goes back to the details with the error on the phone field', async () => {
    await setup();
    fillDetails();
    submit();
    failWith(http.expectOne('/api/account/sign-up'), 409, 'phone_taken', { field: 'phone' });
    await settle();
    expect(q('#su-phone').getAttribute('aria-invalid')).toBe('true');
    expect(q(`#${q('#su-phone').getAttribute('aria-describedby')}`).textContent).toContain('טלפון');
  });

  it('a wrong code shows an error on that code only', async () => {
    await setup();
    fillDetails();
    submit();
    http.expectOne('/api/account/sign-up').flush({ verify: true });
    await settle();
    pasteInto(otp(0), '000000');
    failWith(http.expectOne('/api/account/otp/verify'), 401, 'invalid_code');
    await settle();
    expect(el().querySelectorAll('hg-otp-field .field-error')).toHaveLength(1);
  });

  describe('continuing from a sign-in code (needsSignUp)', () => {
    const draft = {
      phone: '0501234567',
      email: null,
      signUpToken: 'ticket-1',
      verified: { phone: '0501234567', email: null },
    };

    it('shows the verified phone filled and not editable', async () => {
      await setup({ draft });
      expect(q<HTMLInputElement>('#su-phone').value).toBe('0501234567');
      expect(q<HTMLInputElement>('#su-phone').readOnly).toBe(true);
      expect(q<HTMLInputElement>('#su-email').readOnly).toBe(false);
    });

    it('sends a code only to the e-mail, then creates the account with the extended ticket', async () => {
      await setup({ draft });
      fillDetails();
      submit();
      const req = http.expectOne('/api/account/otp/request');
      expect(req.request.body).toEqual({ target: 'dana@example.com', channel: 'email', purpose: 'sign_up' });
      req.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      http.expectNone('/api/account/sign-up');
      await settle();
      expect(el().querySelectorAll('hg-otp-field')).toHaveLength(1);

      pasteInto(otp(0), '333333');
      const verify = http.expectOne('/api/account/otp/verify');
      expect(verify.request.body).toEqual({
        target: 'dana@example.com',
        code: '333333',
        purpose: 'sign_up',
        signUpToken: 'ticket-1',
      });
      verify.flush({
        needsSignUp: true,
        signUpToken: 'ticket-2',
        verified: { phone: '0501234567', email: 'dana@example.com' },
      });
      await settle();
      const final = http.expectOne('/api/account/sign-up');
      expect(final.request.body).toMatchObject({ phone: '0501234567', signUpToken: 'ticket-2' });
      final.flush({ customer: customerMe() });
      await settle();
      expect(navigateByUrl).toHaveBeenCalledWith('/account/orders');
      flushCarts(http);
    });
  });
});
