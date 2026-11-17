import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { CodeTemplateOption, CustomerProfile, Permission } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';
import { CustomerPage } from './customer.page';
import { IssueCodeDialog } from './issue-code.dialog';

const ID = '6f9a1c2e-0000-4000-8000-000000000001';

const PROFILE: CustomerProfile = {
  id: ID,
  fullName: 'דנה כהן',
  phone: '0501234567',
  phoneVerified: true,
  email: 'dana@example.test',
  emailVerified: false,
  createdVia: 'store',
  createdBySeller: { id: 7, name: 'יוסי המוכר' },
  // 22:30 UTC is already the next day in Israel.
  createdAt: '2026-11-05T22:30:00.000Z',
  orders: [
    { number: 100002, createdAt: '2026-11-09T10:00:00.000Z', status: 'paid', total: 115_000, channel: 'web' },
    { number: 100001, createdAt: '2026-11-08T10:00:00.000Z', status: 'expired', total: 50_000, channel: 'store' },
  ],
  orderCount: 2,
  favorites: [{ productId: 9, modelName: 'ALBA', nameHe: 'ספה תלת־מושבית', addedAt: '2026-11-07T08:00:00.000Z' }],
  interests: [{ slug: 'sofas', nameHe: 'ספות' }],
  consent: {
    contact: { status: 'subscribed', source: 'signup', consentAt: '2026-11-04T10:00:00.000Z', unsubscribedAt: null },
    history: [
      { action: 'withdrawn', source: 'account', textVersion: null, actor: 'customer', at: '2026-11-09T10:00:00.000Z' },
      {
        action: 'confirmed',
        source: 'signup',
        textVersion: '2026-11-16',
        actor: 'customer',
        at: '2026-11-04T10:00:00.000Z',
      },
    ],
  },
  codes: [
    {
      code: 'NST-ABCD2345',
      labelHe: 'קוד חג',
      discountKind: 'percent',
      discountValue: 15,
      minSubtotal: null,
      expiresAt: '2026-12-10T21:59:59.999Z',
      status: 'active',
    },
    {
      code: 'NST-WXYZ6789',
      labelHe: 'הצטרפות',
      discountKind: 'fixed',
      discountValue: 20_000,
      minSubtotal: 100_000,
      expiresAt: '2026-10-10T21:59:59.999Z',
      status: 'expired',
    },
  ],
};

const TEMPLATES: CodeTemplateOption[] = [
  { id: 3, name: 'קוד חג', discountType: 'percent', value: 15, minSubtotal: 0, validityDays: 30 },
  { id: 4, name: 'מתנה', discountType: 'fixed', value: 20_000, minSubtotal: 100_000, validityDays: 14 },
];

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('admin customer profile', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  async function open(
    profile: CustomerProfile = PROFILE,
    permissions: Permission[] = ['customers.view', 'orders.view'],
  ) {
    const auth = TestBed.inject(AuthService);
    vi.spyOn(auth, 'can').mockImplementation((p) => permissions.includes(p));
    const fixture = TestBed.createComponent(CustomerPage);
    fixture.componentRef.setInput('id', profile.id);
    fixture.detectChanges();
    http.expectOne(`/api/admin/customers/${profile.id}`).flush(profile);
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }

  it('shows the details: verified phone, unverified e-mail, how and by whom it was created', async () => {
    const { el } = await open();
    expect(el.querySelector('h1')?.textContent).toContain('דנה כהן');
    const details = el.querySelector('.details')!.textContent!.replace(/\s+/g, ' ');
    expect(details).toContain('0501234567');
    expect(details).toContain('dana@example.test');
    expect(el.querySelector('.phone-state')?.textContent?.trim()).toBe('מאומת');
    expect(el.querySelector('.email-state')?.textContent?.trim()).toBe('לא מאומת');
    expect(details).toContain('חנות');
    expect(details).toContain('יוסי המוכר');
    expect(details).toContain('6.11.2026 00:30');
  });

  it('lists the orders with Hebrew status, channel and a link, and says how many there are', async () => {
    const { el } = await open();
    const rows = [...el.querySelectorAll('.orders li')];
    expect(rows).toHaveLength(2);
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/orders/100002');
    expect(rows[0].textContent).toContain('שולמה');
    expect(rows[0].textContent).toContain('אתר');
    expect(rows[1].textContent).toContain('חנות');
    expect(el.querySelector('.orders-note')).toBeNull();
  });

  it('shows no order links without orders.view, and a note when more orders exist than shown', async () => {
    const { el } = await open({ ...PROFILE, orderCount: 120 }, ['customers.view']);
    expect(el.querySelector('.orders a')).toBeNull();
    expect(el.querySelector('.orders li')?.textContent).toContain('100002');
    expect(el.querySelector('.orders-note')?.textContent).toContain('120');
  });

  it('shows favorites, interest categories, consent state with its history, and the codes with their status', async () => {
    const { el } = await open();
    expect(el.querySelector('.favorites')?.textContent).toContain('ALBA');
    expect(el.querySelector('.favorites')?.textContent).toContain('ספה תלת־מושבית');
    expect([...el.querySelectorAll('.interests li')].map((l) => l.textContent?.trim())).toEqual(['ספות']);
    expect(el.querySelector('.consent-state')?.textContent?.trim()).toBe('מאשר דיוור');
    const history = [...el.querySelectorAll('.history li')].map((l) => l.textContent!.replace(/\s+/g, ' ').trim());
    expect(history).toHaveLength(2);
    expect(history[0]).toContain('ביטול הסכמה');
    expect(history[0]).toContain('החשבון');
    expect(history[0]).toContain('הלקוח');
    expect(history[1]).toContain('אישור דיוור');
    expect(history[1]).toContain('הרשמה');
    expect(history[1]).toContain('2026-11-16');
    const codes = [...el.querySelectorAll('.codes li')];
    expect(codes).toHaveLength(2);
    expect(codes[0].querySelector('bdi')?.textContent).toBe('NST-ABCD2345');
    expect(codes[0].textContent).toContain('קוד חג');
    expect(codes[0].textContent).toContain('15%');
    expect(codes[0].querySelector('.code-status')?.textContent?.trim()).toBe('פעיל');
    expect(codes[1].querySelector('.code-status')?.textContent?.trim()).toBe('פג תוקף');
    // The profile never shows any token or hash.
    expect(el.textContent).not.toMatch(/hash|token/i);
  });

  it('shows empty states for a customer with nothing yet', async () => {
    const { el } = await open({
      ...PROFILE,
      createdVia: 'web',
      createdBySeller: null,
      orders: [],
      orderCount: 0,
      favorites: [],
      interests: [],
      consent: { contact: null, history: [] },
      codes: [],
    });
    expect(el.querySelector('.orders')?.textContent).toContain('אין הזמנות');
    expect(el.querySelector('.favorites')?.textContent).toContain('אין מוצרים מועדפים');
    expect(el.querySelector('.interests')?.textContent).toContain('אין עדיין');
    expect(el.querySelector('.consent-state')?.textContent?.trim()).toBe('אין הסכמה רשומה');
    expect(el.querySelector('.codes')?.textContent).toContain('אין קודים אישיים');
  });

  it('shows the issue button only with club.manage', async () => {
    const without = await open(PROFILE, ['customers.view']);
    expect(without.el.querySelector('button.issue-code')).toBeNull();
  });

  it('offers the issue button with club.manage; the dialog opens with this customer and reloads the profile after', async () => {
    const { fixture, el } = await open(PROFILE, ['customers.view', 'club.manage']);
    const button = el.querySelector<HTMLButtonElement>('button.issue-code')!;
    expect(button.textContent?.trim()).toBe('הנפקת קופון אישי');
    const dialog = TestBed.inject(MatDialog);
    const openDialog = vi.spyOn(dialog, 'open').mockReturnValue({ afterClosed: () => of(true) } as never);
    button.click();
    expect(openDialog).toHaveBeenCalledWith(
      IssueCodeDialog,
      expect.objectContaining({
        data: { customerId: ID, fullName: 'דנה כהן', email: 'dana@example.test', emailVerified: false },
      }),
    );
    await settle(fixture);
    http.expectOne(`/api/admin/customers/${ID}`).flush({ ...PROFILE, codes: [] });
    await settle(fixture);
    expect(el.querySelector('.codes')?.textContent).toContain('אין קודים אישיים');
  });

  it('says so when the customer does not exist', async () => {
    const fixture = TestBed.createComponent(CustomerPage);
    fixture.componentRef.setInput('id', 'nope');
    fixture.detectChanges();
    http.expectOne('/api/admin/customers/nope').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain('לא נמצא');
  });
});

describe('issue personal coupon dialog', () => {
  let http: HttpTestingController;
  const close = vi.fn();
  const DATA = { customerId: ID, fullName: 'דנה כהן', email: 'dana@example.test', emailVerified: true };

  const mount = (data: object = DATA) => {
    close.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MAT_DIALOG_DATA, useValue: data },
        { provide: MatDialogRef, useValue: { close } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(IssueCodeDialog);
    fixture.detectChanges();
    return fixture;
  };

  afterEach(() => http.verify());

  const choose = (el: HTMLElement, selector: string) => el.querySelector<HTMLInputElement>(selector)!.click();

  it('lists the active templates, issues the chosen one with the chosen sending and shows the code', async () => {
    const fixture = mount();
    const el = fixture.nativeElement as HTMLElement;
    http.expectOne('/api/admin/customers/code-templates').flush(TEMPLATES);
    await settle(fixture);
    const options = [...el.querySelectorAll('.templates label')].map((l) => l.textContent!.replace(/\s+/g, ' ').trim());
    expect(options[0]).toContain('קוד חג');
    expect(options[0]).toContain('15%');
    expect(options[0]).toContain('30 ימים');
    expect(options[1]).toContain('מתנה');
    expect(options[1]).toContain('קנייה מעל');
    // Nothing is sent before a template is chosen.
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle(fixture);
    expect(el.querySelector('[role=alert]')?.textContent).toContain('בחרו תבנית');
    http.expectNone('/api/admin/customers/' + ID + '/codes');

    choose(el, 'input[name="template"][value="4"]');
    choose(el, 'input[name="send"][value="sms"]');
    await settle(fixture);
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    const req = http.expectOne(`/api/admin/customers/${ID}/codes`);
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ templateId: 4, send: 'sms' });
    req.flush({ code: 'NST-ABCD2345', expiresAt: '2026-12-10T21:59:59.999Z' });
    await settle(fixture);
    expect(el.querySelector('.issued bdi')?.textContent).toBe('NST-ABCD2345');
    expect(el.querySelector('.issued')?.textContent).toContain('10.12.2026');
    expect(el.querySelector('form')).toBeNull();
    el.querySelector<HTMLButtonElement>('button.done')!.click();
    expect(close).toHaveBeenCalledWith(true);
  });

  it('defaults to "not sent" and cannot send an e-mail without a verified e-mail', async () => {
    const fixture = mount({ ...DATA, emailVerified: false });
    const el = fixture.nativeElement as HTMLElement;
    http.expectOne('/api/admin/customers/code-templates').flush(TEMPLATES);
    await settle(fixture);
    expect(el.querySelector<HTMLInputElement>('input[name="send"][value="none"]')!.checked).toBe(true);
    expect(el.querySelector<HTMLInputElement>('input[name="send"][value="email"]')!.disabled).toBe(true);
    expect(el.querySelector<HTMLInputElement>('input[name="send"][value="sms"]')!.disabled).toBe(false);
  });

  it('says when there is no active template', async () => {
    const fixture = mount();
    http.expectOne('/api/admin/customers/code-templates').flush([]);
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).textContent).toContain('אין תבניות פעילות');
  });

  it('shows the API refusal in Hebrew and keeps the dialog open', async () => {
    const fixture = mount();
    const el = fixture.nativeElement as HTMLElement;
    http.expectOne('/api/admin/customers/code-templates').flush(TEMPLATES);
    await settle(fixture);
    choose(el, 'input[name="template"][value="3"]');
    choose(el, 'input[name="send"][value="email"]');
    await settle(fixture);
    el.querySelector<HTMLFormElement>('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
    http
      .expectOne(`/api/admin/customers/${ID}/codes`)
      .flush({ statusCode: 409, code: 'email_not_verified', field: 'send' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('[role=alert]')?.textContent).toContain('אין ללקוח מייל מאומת');
    expect(close).not.toHaveBeenCalled();
  });

  it('maps the refusals to Hebrew', () => {
    const err = (status: number, body: object) => new HttpErrorResponse({ status, error: body });
    expect(errorMessage(err(409, { code: 'email_not_verified', field: 'send' }))).toContain('מייל מאומת');
    expect(errorMessage(err(400, { code: 'invalid', field: 'templateId' }))).toContain('התבנית');
  });
});
