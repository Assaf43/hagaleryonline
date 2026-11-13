import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { CODE_SENT_MESSAGE_HE } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { SignUpDraft } from './sign-up-draft';
import { SignInPage } from './sign-in.page';
import { customerMe, failWith, flushCarts, pasteInto, provideAccountTesting, typeInto, tick } from './account.testing';

describe('SignInPage', () => {
  let fixture: ComponentFixture<SignInPage>;
  let http: HttpTestingController;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;
  let navigate: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const q = <T extends HTMLElement>(sel: string) => el().querySelector<T>(sel)!;
  const tab = (id: string) => q<HTMLButtonElement>(`#tab-${id}`);
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  async function setup(next?: string) {
    http = provideAccountTesting();
    const router = TestBed.inject(Router);
    navigateByUrl = vi.spyOn(router, 'navigateByUrl').mockResolvedValue(true);
    navigate = vi.spyOn(router, 'navigate').mockResolvedValue(true);
    fixture = TestBed.createComponent(SignInPage);
    if (next !== undefined) fixture.componentRef.setInput('next', next);
    fixture.detectChanges();
    // The page waits for the session read before it shows the form.
    http.expectOne('/api/account/me').flush(null);
    await settle();
  }

  afterEach(() => http.verify());

  it('is noindex', async () => {
    http = provideAccountTesting();
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(SignInPage);
    fixture.detectChanges();
    http.expectOne('/api/account/me').flush(null);
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
  });

  it('has the three tabs with tab semantics and arrow-key movement', async () => {
    await setup();
    const tabs = [...el().querySelectorAll<HTMLElement>('[role="tab"]')];
    expect(tabs.map((t) => t.textContent?.trim())).toEqual(['סיסמה', 'קוד ב־SMS', 'קוד במייל']);
    expect(q('[role="tablist"]')).toBeTruthy();
    expect(tab('password').getAttribute('aria-selected')).toBe('true');
    expect(tab('password').tabIndex).toBe(0);
    expect(tab('sms').tabIndex).toBe(-1);
    const panel = q('[role="tabpanel"]');
    expect(panel.getAttribute('aria-labelledby')).toBe('tab-password');
    expect(tab('password').getAttribute('aria-controls')).toBe(panel.id);

    // Keyboard: ArrowLeft moves to the next tab in a right-to-left page, ArrowRight back.
    tab('password').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle();
    expect(tab('sms').getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tab('sms'));
    tab('sms').dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    await settle();
    expect(tab('email').getAttribute('aria-selected')).toBe('true');
    tab('email').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await settle();
    expect(tab('sms').getAttribute('aria-selected')).toBe('true');
    tab('sms').dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    await settle();
    expect(tab('password').getAttribute('aria-selected')).toBe('true');
  });

  describe('password', () => {
    it('signs in, stores the customer, reloads the cart and goes to ?next=', async () => {
      await setup('/account/details');
      typeInto(q('#si-email'), ' Dana@Example.com ');
      typeInto(q('#si-password'), 'secret-pass');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/sign-in');
      expect(req.request.body).toEqual({ email: 'dana@example.com', password: 'secret-pass' });
      req.flush({ customer: customerMe() });
      await settle();
      expect(TestBed.inject(CustomerStore).me()?.email).toBe('dana@example.com');
      expect(navigateByUrl).toHaveBeenCalledWith('/account/details');
      flushCarts(http);
    });

    it('an unsafe ?next= goes to the orders list (no open redirect)', async () => {
      await setup('//evil.example/phish');
      typeInto(q('#si-email'), 'dana@example.com');
      typeInto(q('#si-password'), 'secret-pass');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      http.expectOne('/api/account/sign-in').flush({ customer: customerMe() });
      await settle();
      expect(navigateByUrl).toHaveBeenCalledWith('/account/orders');
      flushCarts(http);
    });

    it('shows the generic wrong-details text, tied to the form', async () => {
      await setup();
      typeInto(q('#si-email'), 'dana@example.com');
      typeInto(q('#si-password'), 'bad');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      failWith(http.expectOne('/api/account/sign-in'), 401, 'invalid_credentials');
      await settle();
      const err = q('.form-error');
      expect(err.textContent?.trim()).toBe('פרטי ההתחברות שגויים');
      expect(err.getAttribute('role')).toBe('alert');
      expect(navigateByUrl).not.toHaveBeenCalled();
    });

    it('shows a generic too-many-attempts text on 429', async () => {
      await setup();
      typeInto(q('#si-email'), 'dana@example.com');
      typeInto(q('#si-password'), 'bad');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      failWith(http.expectOne('/api/account/sign-in'), 429, 'too_many_attempts', { retryAfterSeconds: 30 });
      await settle();
      expect(text()).toContain('ביצעתם יותר מדי ניסיונות');
    });

    it('checks the fields before sending, each error tied with aria-describedby', async () => {
      await setup();
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      await settle();
      http.expectNone('/api/account/sign-in');
      const email = q('#si-email');
      expect(email.getAttribute('aria-invalid')).toBe('true');
      expect(q(`#${email.getAttribute('aria-describedby')}`).textContent).toContain('דוא״ל');
      expect(q('#si-password').getAttribute('aria-describedby')).toBeTruthy();
    });
  });

  describe('code by SMS', () => {
    async function openSms() {
      await setup('/cart');
      tab('sms').click();
      await settle();
    }

    it('asks for a phone, sends a code with the generic text, then signs in with the pasted code', async () => {
      await openSms();
      typeInto(q('#si-target'), '050-123 4567');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/otp/request');
      expect(req.request.body).toEqual({ target: '0501234567', channel: 'sms', purpose: 'sign_in' });
      req.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      expect(text()).toContain(CODE_SENT_MESSAGE_HE);
      expect(CODE_SENT_MESSAGE_HE).toBe('אם קיים חשבון, שלחנו קוד');
      expect(el().querySelectorAll('hg-otp-field input')).toHaveLength(6);

      pasteInto(q('hg-otp-field input'), '123456');
      const verify = http.expectOne('/api/account/otp/verify');
      expect(verify.request.body).toEqual({ target: '0501234567', code: '123456', purpose: 'sign_in' });
      verify.flush({ customer: customerMe() });
      await settle();
      expect(TestBed.inject(CustomerStore).me()).not.toBeNull();
      expect(navigateByUrl).toHaveBeenCalledWith('/cart');
      flushCarts(http);
    });

    it('rejects a malformed phone before sending', async () => {
      await openSms();
      typeInto(q('#si-target'), '12345');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      await settle();
      http.expectNone('/api/account/otp/request');
      expect(q('#si-target').getAttribute('aria-invalid')).toBe('true');
    });

    it('a wrong code shows an error, clears the boxes and keeps the step', async () => {
      await openSms();
      typeInto(q('#si-target'), '0501234567');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      http.expectOne('/api/account/otp/request').flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      pasteInto(q('hg-otp-field input'), '000000');
      failWith(http.expectOne('/api/account/otp/verify'), 401, 'invalid_code');
      await settle();
      expect(text()).toContain('הקוד שגוי');
      expect([...el().querySelectorAll<HTMLInputElement>('hg-otp-field input')].every((i) => i.value === '')).toBe(
        true,
      );
      // Focus is back on box 1 (the boxes are never disabled while the code is checked) and the error is announced.
      expect(document.activeElement).toBe(q('hg-otp-field input'));
      expect(q('hg-otp-field .field-error').getAttribute('role')).toBe('alert');
      expect(q('hg-otp-field .field-error').textContent).toContain('הקוד שגוי');
    });

    it('a code completed while the previous one is being checked is not dropped', async () => {
      await openSms();
      typeInto(q('#si-target'), '0501234567');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      http.expectOne('/api/account/otp/request').flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      pasteInto(q('hg-otp-field input'), '000000');
      pasteInto(q('hg-otp-field input'), '111111');
      const first = http.expectOne('/api/account/otp/verify');
      failWith(first, 401, 'invalid_code');
      await settle();
      const second = http.expectOne('/api/account/otp/verify');
      expect(second.request.body).toMatchObject({ code: '111111' });
      second.flush({ customer: customerMe() });
      await settle();
      flushCarts(http);
    });

    it('needsSignUp continues to the sign-up page with the phone filled', async () => {
      await openSms();
      typeInto(q('#si-target'), '0501234567');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      http.expectOne('/api/account/otp/request').flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      pasteInto(q('hg-otp-field input'), '123456');
      http.expectOne('/api/account/otp/verify').flush({
        needsSignUp: true,
        signUpToken: 'ticket-1',
        verified: { phone: '0501234567', email: null },
      });
      await settle();
      const draft = TestBed.inject(SignUpDraft).current();
      expect(draft).toEqual({
        phone: '0501234567',
        email: null,
        signUpToken: 'ticket-1',
        verified: { phone: '0501234567', email: null },
      });
      expect(navigate).toHaveBeenCalledWith(['/account/sign-up'], { queryParams: { next: '/cart' } });
      expect(TestBed.inject(CustomerStore).me()).toBeNull();
    });

    it('a 429 on the code request shows the generic too-many message', async () => {
      await openSms();
      typeInto(q('#si-target'), '0501234567');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      failWith(http.expectOne('/api/account/otp/request'), 429, 'too_many_requests');
      await settle();
      expect(text()).toContain('ביצעתם יותר מדי ניסיונות');
    });
  });

  describe('code by e-mail', () => {
    it('sends the e-mail channel and signs in with the code', async () => {
      await setup();
      tab('email').click();
      await settle();
      typeInto(q('#si-target'), 'Dana@Example.com');
      q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/otp/request');
      expect(req.request.body).toEqual({ target: 'dana@example.com', channel: 'email', purpose: 'sign_in' });
      req.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      expect(text()).toContain(CODE_SENT_MESSAGE_HE);
      pasteInto(q('hg-otp-field input'), '654321');
      const verify = http.expectOne('/api/account/otp/verify');
      expect(verify.request.body).toEqual({ target: 'dana@example.com', code: '654321', purpose: 'sign_in' });
      verify.flush({ customer: customerMe() });
      await settle();
      expect(navigateByUrl).toHaveBeenCalledWith('/account/orders');
      flushCarts(http);
    });

    it('resend asks for a new code to the same target', async () => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      try {
        await setup();
        tab('email').click();
        await settle();
        typeInto(q('#si-target'), 'dana@example.com');
        q<HTMLButtonElement>('form.request-form button[type="submit"]').click();
        http.expectOne('/api/account/otp/request').flush({ sent: true }, { status: 202, statusText: 'Accepted' });
        await settle();
        vi.advanceTimersByTime(60_000);
        fixture.detectChanges();
        q<HTMLButtonElement>('button.resend').click();
        const again = http.expectOne('/api/account/otp/request');
        expect(again.request.body).toEqual({ target: 'dana@example.com', channel: 'email', purpose: 'sign_in' });
        again.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('forgot password', () => {
    it('asks for a code by e-mail, then sets the new password and signs in', async () => {
      await setup();
      q<HTMLButtonElement>('button.forgot').click();
      await settle();
      typeInto(q('#si-reset-email'), 'dana@example.com');
      q<HTMLButtonElement>('form.reset-request-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/password/reset/request');
      expect(req.request.body).toEqual({ email: 'dana@example.com' });
      req.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      expect(text()).toContain(CODE_SENT_MESSAGE_HE);
      pasteInto(q('hg-otp-field input'), '111222');
      typeInto(q('#si-reset-password'), 'brand-new-pass');
      q<HTMLButtonElement>('form.reset-form button[type="submit"]').click();
      const reset = http.expectOne('/api/account/password/reset');
      expect(reset.request.body).toEqual({ email: 'dana@example.com', code: '111222', next: 'brand-new-pass' });
      reset.flush({ customer: customerMe() });
      await settle();
      expect(TestBed.inject(CustomerStore).me()).not.toBeNull();
      expect(navigateByUrl).toHaveBeenCalledWith('/account/orders');
      flushCarts(http);
    });

    it('editing a digit drops the code entered before: submitting needs a full code again', async () => {
      await setup();
      q<HTMLButtonElement>('button.forgot').click();
      await settle();
      typeInto(q('#si-reset-email'), 'dana@example.com');
      q<HTMLButtonElement>('form.reset-request-form button[type="submit"]').click();
      http
        .expectOne('/api/account/password/reset/request')
        .flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      pasteInto(q('hg-otp-field input'), '111222');
      const box = q<HTMLInputElement>('hg-otp-field input');
      box.value = '';
      box.dispatchEvent(new Event('input', { bubbles: true }));
      typeInto(q('#si-reset-password'), 'brand-new-pass');
      q<HTMLButtonElement>('form.reset-form button[type="submit"]').click();
      await settle();
      http.expectNone('/api/account/password/reset');
      expect(q('hg-otp-field .field-error').textContent).toContain('הקוד');
    });
  });
});
