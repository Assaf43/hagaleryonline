import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import type { StoreCartView } from '@hg/models';
import { CustomerStep } from './customer-step';

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('store sale customer step', () => {
  let http: HttpTestingController;
  let fixture: ComponentFixture<CustomerStep>;
  const el = () => fixture.nativeElement as HTMLElement;
  const type = (name: string, value: string) => {
    const input = el().querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  const lookup = async (phone: string, answer: object) => {
    type('phone', phone);
    el().querySelector('form')!.dispatchEvent(new Event('submit'));
    http.expectOne('/api/admin/store-cart/customer/lookup').flush(answer);
    await settle(fixture);
  };
  const labels = () => [...el().querySelectorAll('button')].map((b) => b.textContent?.trim());

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CustomerStep);
    fixture.detectChanges();
  });
  afterEach(() => http.verify());

  it('hides the e-mail code button when the account e-mail is not verified', async () => {
    await lookup('0501234567', {
      exists: true,
      fullName: 'דנה',
      maskedEmail: 'd***@example.test',
      emailVerified: false,
    });
    expect(labels()).toContain('שלח קוד ב-SMS');
    expect(labels()).not.toContain('שלח קוד למייל');
  });

  it('offers both codes for a verified e-mail and sends it with the email key only', async () => {
    await lookup('0501234567', {
      exists: true,
      fullName: 'דנה',
      maskedEmail: 'd***@example.test',
      emailVerified: true,
    });
    expect(labels()).toContain('שלח קוד למייל');
    expect(el().querySelector('bdi[dir="ltr"]')?.textContent).toBe('d***@example.test');
    [...el().querySelectorAll('button')].find((b) => b.textContent?.includes('למייל'))!.click();
    const req = http.expectOne('/api/admin/store-cart/customer/code');
    expect(req.request.body).toEqual({ phone: '0501234567', channel: 'email' });
    req.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('takes six digits only in the code field and enables the confirm button at six', async () => {
    await lookup('0501234567', { exists: true, fullName: 'דנה', maskedEmail: null, emailVerified: false });
    type('email', 'dana@example.test');
    [...el().querySelectorAll('button')].find((b) => b.textContent?.includes('SMS'))!.click();
    const req = http.expectOne('/api/admin/store-cart/customer/code');
    expect(req.request.body).toEqual({
      phone: '0501234567',
      channel: 'sms',
      newCustomer: { email: 'dana@example.test' },
    });
    req.flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    type('code', '12ab34-56789');
    const code = el().querySelector<HTMLInputElement>('input[name="code"]')!;
    expect(code.value).toBe('123456');
    type('code', '12345');
    fixture.detectChanges();
    const confirm = () =>
      [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.trim() === 'אישור')!;
    expect(confirm().disabled).toBe(true);
    type('code', '123456');
    fixture.detectChanges();
    expect(confirm().disabled).toBe(false);
  });

  it('offers to confirm the existing account on email_taken, by an e-mail code', async () => {
    await lookup('0509999999', { exists: false });
    type('fullName', 'רון לוי');
    type('email', 'ron@example.test');
    [...el().querySelectorAll('button')].find((b) => b.textContent?.trim() === 'שלח קוד')!.click();
    http
      .expectOne('/api/admin/store-cart/customer/code')
      .flush({ statusCode: 409, code: 'email_taken' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    const confirmExisting = [...el().querySelectorAll('button')].find((b) =>
      b.textContent?.includes('אשר את החשבון הקיים'),
    )!;
    confirmExisting.click();
    const req = http.expectOne('/api/admin/store-cart/customer/code');
    expect(req.request.body).toEqual({ email: 'ron@example.test', channel: 'email' });
    req.flush(null, { status: 204, statusText: 'No Content' });
  });

  it('shows the confirmed customer with the phone inside bdi', async () => {
    fixture.componentRef.setInput('cart', {
      lines: [],
      customer: { id: 'c', fullName: 'דנה כהן', phone: '0501234567', email: null, emailVerified: false, isNew: false },
    } as unknown as StoreCartView);
    fixture.detectChanges();
    expect(el().querySelector('bdi[dir="ltr"]')?.textContent).toBe('0501234567');
    expect(labels()).toContain('המשך למשלוח');
  });
});
