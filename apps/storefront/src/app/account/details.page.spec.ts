import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { DetailsPage } from './details.page';
import {
  customerMe,
  failWith,
  pasteInto,
  provideAccountTesting,
  signedIn,
  typeInto,
  tick,
  flushCarts,
} from './account.testing';

describe('DetailsPage', () => {
  let fixture: ComponentFixture<DetailsPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const q = <T extends HTMLElement>(sel: string) => el().querySelector<T>(sel)!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  async function setup(me = customerMe()) {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore), me);
    fixture = TestBed.createComponent(DetailsPage);
    fixture.detectChanges();
    await settle();
  }

  afterEach(() => http.verify());

  it('is noindex and shows the name, phone and e-mail', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(DetailsPage);
    fixture.detectChanges();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(q<HTMLInputElement>('#dt-name').value).toBe('דנה כהן');
    expect(text()).toContain('0501234567');
    expect(text()).toContain('dana@example.com');
    expect(el().querySelectorAll('bdi').length).toBeGreaterThanOrEqual(2);
  });

  describe('name', () => {
    it('is editable: prefilled, saved with PUT /api/account/name', async () => {
      await setup();
      expect(q<HTMLInputElement>('#dt-name').value).toBe('דנה כהן');
      expect(el().querySelector('label[for="dt-name"]')).not.toBeNull();
      typeInto(q('#dt-name'), '  דנה לוי ');
      q<HTMLButtonElement>('form.name-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/name');
      expect(req.request.method).toBe('PUT');
      expect(req.request.body).toEqual({ name: 'דנה לוי' });
      req.flush(customerMe({ fullName: 'דנה לוי' }));
      await settle();
      expect(TestBed.inject(CustomerStore).me()?.fullName).toBe('דנה לוי');
      expect(q('[role="status"]').textContent).toContain('השם עודכן');
    });

    it('rejects a too-short name before sending, tied to the field', async () => {
      await setup();
      typeInto(q('#dt-name'), 'ד');
      q<HTMLButtonElement>('form.name-form button[type="submit"]').click();
      await settle();
      http.expectNone('/api/account/name');
      expect(q('#dt-name').getAttribute('aria-invalid')).toBe('true');
      expect(q(`#${q('#dt-name').getAttribute('aria-describedby')}`).textContent).toContain('שם מלא');
    });

    it('a server refusal shows on the field', async () => {
      await setup();
      typeInto(q('#dt-name'), 'דנה לוי');
      q<HTMLButtonElement>('form.name-form button[type="submit"]').click();
      failWith(http.expectOne('/api/account/name'), 400, 'invalid_input', { field: 'name' });
      await settle();
      expect(q('#dt-name').getAttribute('aria-invalid')).toBe('true');
    });
  });

  it('a signed-out answer (401) goes to sign-in with ?next=', async () => {
    await setup();
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    typeInto(q('#dt-current'), 'old-password');
    typeInto(q('#dt-next'), 'brand-new-pass');
    q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
    failWith(http.expectOne('/api/account/password'), 401, 'not_authenticated');
    await settle();
    expect(TestBed.inject(CustomerStore).me()).toBeNull();
    expect(navigate).toHaveBeenCalledWith(['/account'], { queryParams: { next: expect.any(String) } });
    flushCarts(http);
  });

  describe('phone change', () => {
    it('sends a code to the new number, then saves it with the code', async () => {
      await setup();
      typeInto(q('#dt-phone'), '052-7654321');
      q<HTMLButtonElement>('form.phone-form button[type="submit"]').click();
      const change = http.expectOne('/api/account/contact/change');
      expect(change.request.body).toEqual({ kind: 'phone', value: '0527654321' });
      change.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      expect(el().querySelectorAll('hg-otp-field input')).toHaveLength(6);

      pasteInto(q('hg-otp-field input'), '123456');
      const confirm = http.expectOne('/api/account/contact/confirm');
      expect(confirm.request.body).toEqual({ kind: 'phone', code: '123456' });
      confirm.flush({ customer: customerMe({ phone: '0527654321' }) });
      await settle();
      expect(TestBed.inject(CustomerStore).me()?.phone).toBe('0527654321');
      expect(el().querySelector('hg-otp-field')).toBeNull();
      expect(q('[role="status"]').textContent).toContain('הטלפון עודכן');
    });

    it('checks the number before asking for a code', async () => {
      await setup();
      typeInto(q('#dt-phone'), '123');
      q<HTMLButtonElement>('form.phone-form button[type="submit"]').click();
      await settle();
      http.expectNone('/api/account/contact/change');
      expect(q('#dt-phone').getAttribute('aria-invalid')).toBe('true');
    });

    it('a number that belongs to another account is refused on its field', async () => {
      await setup();
      typeInto(q('#dt-phone'), '0527654321');
      q<HTMLButtonElement>('form.phone-form button[type="submit"]').click();
      failWith(http.expectOne('/api/account/contact/change'), 409, 'phone_taken', { field: 'phone' });
      await settle();
      expect(q('#dt-phone').getAttribute('aria-invalid')).toBe('true');
      expect(el().querySelector('hg-otp-field')).toBeNull();
    });
  });

  describe('e-mail change', () => {
    it('sends the e-mail kind', async () => {
      await setup();
      typeInto(q('#dt-email'), 'New@Example.com');
      q<HTMLButtonElement>('form.email-form button[type="submit"]').click();
      const change = http.expectOne('/api/account/contact/change');
      expect(change.request.body).toEqual({ kind: 'email', value: 'new@example.com' });
      change.flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      pasteInto(q('hg-otp-field input'), '654321');
      const confirm = http.expectOne('/api/account/contact/confirm');
      expect(confirm.request.body).toEqual({ kind: 'email', code: '654321' });
      confirm.flush({ customer: customerMe({ email: 'new@example.com' }) });
      await settle();
      expect(TestBed.inject(CustomerStore).me()?.email).toBe('new@example.com');
    });

    it('a wrong code keeps the step with an error', async () => {
      await setup();
      typeInto(q('#dt-email'), 'new@example.com');
      q<HTMLButtonElement>('form.email-form button[type="submit"]').click();
      http.expectOne('/api/account/contact/change').flush({ sent: true }, { status: 202, statusText: 'Accepted' });
      await settle();
      pasteInto(q('hg-otp-field input'), '000000');
      failWith(http.expectOne('/api/account/contact/confirm'), 401, 'invalid_code');
      await settle();
      expect(el().querySelector('hg-otp-field .field-error')?.textContent).toContain('הקוד שגוי');
    });
  });

  describe('password', () => {
    it('with a password already set, asks for the current one and sends both', async () => {
      await setup();
      expect(el().querySelector('label[for="dt-current"]')).not.toBeNull();
      typeInto(q('#dt-current'), 'old-password');
      typeInto(q('#dt-next'), 'brand-new-pass');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/password');
      expect(req.request.body).toEqual({ current: 'old-password', next: 'brand-new-pass' });
      req.flush({ customer: customerMe() });
      await settle();
      expect(q('[role="status"]').textContent).toContain('הסיסמה נשמרה');
    });

    it('without a password, sets the first one with no current field', async () => {
      await setup(customerMe({ hasPassword: false }));
      expect(el().querySelector('#dt-current')).toBeNull();
      typeInto(q('#dt-next'), 'first-password');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      const req = http.expectOne('/api/account/password');
      expect(req.request.body).toEqual({ next: 'first-password' });
      req.flush({ customer: customerMe({ hasPassword: true }) });
      await settle();
      expect(TestBed.inject(CustomerStore).me()?.hasPassword).toBe(true);
    });

    it('rejects a short password before sending, tied to the field', async () => {
      await setup();
      typeInto(q('#dt-current'), 'old-password');
      typeInto(q('#dt-next'), 'short');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      await settle();
      http.expectNone('/api/account/password');
      expect(q('#dt-next').getAttribute('aria-invalid')).toBe('true');
      expect(q(`#${q('#dt-next').getAttribute('aria-describedby')}`).textContent).toContain('8');
    });

    it('a wrong current password is shown on that field', async () => {
      await setup();
      typeInto(q('#dt-current'), 'wrong-password');
      typeInto(q('#dt-next'), 'brand-new-pass');
      q<HTMLButtonElement>('form.password-form button[type="submit"]').click();
      failWith(http.expectOne('/api/account/password'), 400, 'wrong_password');
      await settle();
      expect(q('#dt-current').getAttribute('aria-invalid')).toBe('true');
      expect(text()).toContain('הסיסמה הנוכחית שגויה');
    });
  });
});
