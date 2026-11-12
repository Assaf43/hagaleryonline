import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MAT_DIALOG_DATA, MatDialog, MatDialogRef } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { AdminMe, AdminOrderDetail, AdminRefund, Permission } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';
import { CancelDialog } from './cancel-dialog';
import { ConfirmDialog } from './confirm-dialog';
import { OrderDetailPage } from './order-detail.page';
import { RefundDialog } from './refund-dialog';
import { parseShekels } from './shekels';
import { SlotDialog, validateSlot } from './slot-dialog';
import { StatusTimeline } from './status-timeline';
import { HttpErrorResponse } from '@angular/common/http';

const DETAIL: AdminOrderDetail = {
  number: 100002,
  status: 'paid',
  createdAt: '2026-11-09T10:00:00.000Z',
  reservedUntil: '2026-11-09T10:20:00.000Z',
  contact: { fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.test' },
  address: {
    localityId: 5000,
    localityNameHe: 'תל אביב - יפו',
    street: 'הרצל',
    houseNumber: '1',
    apartment: null,
    floor: 2,
    hasElevator: true,
    notes: null,
  },
  method: 'curbside',
  shippingTotal: 15_000,
  shippingLines: [],
  subtotal: 100_000,
  discount: 0,
  discountInfo: null,
  total: 115_000,
  deliveryEstimate: null,
  lines: [],
  stockShortage: false,
  refundedTotal: 0,
  refundable: 115_000,
  attentionNote: null,
  refunds: [],
  deliverySlot: null,
  canCancel: true,
  nextStatuses: ['processing', 'delivery_scheduled', 'shipped', 'delivered'],
  statusEvents: [],
  needsAttention: false,
  attentionReasons: [],
  paymentProvider: 'sandbox',
  shippingProvider: 'manual',
  payments: [],
};

const FAILED_REFUND: AdminRefund = {
  id: 'r1',
  amount: 20_000,
  reason: 'פגם',
  status: 'failed',
  provider: 'sandbox',
  adminUserId: 7,
  error: 'declined',
  createdAt: '2026-11-10T09:00:00.000Z',
};

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

const type = (el: HTMLInputElement | HTMLTextAreaElement, value: string) => {
  el.value = value;
  el.dispatchEvent(new Event('input'));
};

describe('shekels and slot rules', () => {
  it('turns shekels into integer agorot once, and refuses what is not money', () => {
    expect(parseShekels('250')).toBe(25_000);
    expect(parseShekels('250.5')).toBe(25_050);
    expect(parseShekels('19.99')).toBe(1_999);
    expect(parseShekels('0.1')).toBe(10);
    expect(parseShekels('')).toBeNull();
    expect(parseShekels('abc')).toBeNull();
    expect(parseShekels('1.234')).toBeNull();
    expect(parseShekels('-5')).toBeNull();
  });

  it('validates the slot: all fields, and the window must start before it ends', () => {
    expect(validateSlot({ date: '', windowFrom: '10:00', windowTo: '12:00' })).toBe('date');
    expect(validateSlot({ date: '2026-12-01', windowFrom: '', windowTo: '12:00' })).toBe('window');
    expect(validateSlot({ date: '2026-12-01', windowFrom: '12:00', windowTo: '10:00' })).toBe('window');
    expect(validateSlot({ date: '2026-12-01', windowFrom: '10:00', windowTo: '10:00' })).toBe('window');
    expect(validateSlot({ date: '2026-12-01', windowFrom: '10:00', windowTo: '12:00' })).toBeNull();
  });

  it('maps the new API errors to Hebrew', () => {
    const err = (status: number, body: object) => new HttpErrorResponse({ status, error: body });
    expect(errorMessage(err(409, { code: 'invalid_transition' }))).toBe('אי אפשר לעבור לסטטוס הזה');
    expect(errorMessage(err(409, { code: 'refund_exceeds_paid' }))).toBe('הסכום גדול מהיתרה להחזר');
    expect(errorMessage(err(400, { code: 'invalid_input', field: 'slot.date' }))).toContain('תאריך');
    expect(errorMessage(err(400, { code: 'invalid_input', field: 'reason' }))).toContain('סיבה');
  });
});

describe('order action dialogs', () => {
  let http: HttpTestingController;
  const close = vi.fn();

  const mount = <T>(cmp: new () => T, data: object) => {
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
    const fixture = TestBed.createComponent(cmp);
    fixture.detectChanges();
    return fixture as ComponentFixture<T>;
  };

  afterEach(() => http.verify());

  it('slot dialog: blocks an inverted window, then sends the slot', async () => {
    const fixture = mount(SlotDialog, { number: 100002, slot: null });
    const el = fixture.nativeElement as HTMLElement;
    const q = <E extends HTMLElement>(s: string) => el.querySelector<E>(s)!;
    type(q<HTMLInputElement>('input[name=date]'), '2026-12-01');
    type(q<HTMLInputElement>('input[name=from]'), '14:00');
    type(q<HTMLInputElement>('input[name=to]'), '12:00');
    fixture.detectChanges();
    q<HTMLButtonElement>('button[type=submit]').click();
    fixture.detectChanges();
    http.expectNone('/api/admin/orders/100002/status');
    expect(el.querySelector('[role=alert]')?.textContent).toContain('שעת ההתחלה');

    type(q<HTMLInputElement>('input[name=to]'), '16:00');
    type(q<HTMLInputElement>('input[name=note]'), 'להתקשר');
    fixture.detectChanges();
    q<HTMLButtonElement>('button[type=submit]').click();
    const req = http.expectOne('/api/admin/orders/100002/status');
    expect(req.request.body).toEqual({
      to: 'delivery_scheduled',
      slot: { date: '2026-12-01', windowFrom: '14:00', windowTo: '16:00', note: 'להתקשר' },
    });
    req.flush(DETAIL);
    await settle(fixture);
    expect(close).toHaveBeenCalledWith(DETAIL);
  });

  it('cancel dialog: needs a reason, limits a partial amount, sends agorot', async () => {
    const fixture = mount(CancelDialog, { number: 100002, refundable: 115_000, status: 'paid' });
    const el = fixture.nativeElement as HTMLElement;
    const submit = () => el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    const radio = (value: string) => el.querySelector<HTMLInputElement>(`input[type=radio][value=${value}]`)!;
    const restock = el.querySelector<HTMLInputElement>('input[type=checkbox]')!;
    expect(restock.checked).toBe(true);
    expect(submit().textContent).toContain('ביטול ההזמנה');
    expect(submit().disabled).toBe(true); // no reason yet

    type(el.querySelector('textarea')!, 'ab');
    fixture.detectChanges();
    expect(submit().disabled).toBe(true); // 3 characters at least
    type(el.querySelector('textarea')!, 'הלקוח התחרט');
    fixture.detectChanges();
    expect(submit().disabled).toBe(false);

    radio('partial').click();
    fixture.detectChanges();
    const amount = el.querySelector<HTMLInputElement>('input[name=amount]')!;
    expect(submit().disabled).toBe(true); // amount missing
    type(amount, '1150.01');
    fixture.detectChanges();
    expect(submit().disabled).toBe(true); // above the refundable amount
    type(amount, '250.5');
    fixture.detectChanges();
    expect(submit().disabled).toBe(false);

    restock.click();
    fixture.detectChanges();
    submit().click();
    const req = http.expectOne('/api/admin/orders/100002/cancel');
    expect(req.request.body).toEqual({
      refund: 'partial',
      amount: 25_050,
      reason: 'הלקוח התחרט',
      restock: false,
    });
    req.flush({ code: 'refund_exceeds_paid' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(el.querySelector('[role=alert]')?.textContent).toContain('הסכום גדול מהיתרה להחזר');
    expect(close).not.toHaveBeenCalled();
  });

  it('cancel dialog: a full refund sends no amount; an unpaid order offers no refund options', async () => {
    const full = mount(CancelDialog, { number: 100002, refundable: 115_000, status: 'paid' });
    const el = full.nativeElement as HTMLElement;
    type(el.querySelector('textarea')!, 'טעות בהזמנה');
    full.detectChanges();
    el.querySelector<HTMLInputElement>('input[type=radio][value=full]')!.click();
    full.detectChanges();
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const req = http.expectOne('/api/admin/orders/100002/cancel');
    expect(req.request.body).toEqual({ refund: 'full', reason: 'טעות בהזמנה', restock: true });
    req.flush(DETAIL);
    await settle(full);
    expect(close).toHaveBeenCalledWith(DETAIL);
  });

  it('cancel dialog: nothing to refund means no radios, and refund "none"', async () => {
    TestBed.resetTestingModule();
    const fixture = mount(CancelDialog, { number: 100003, refundable: 0, status: 'pending_payment' });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('input[type=radio]')).toHaveLength(0);
    expect(el.querySelector('input[type=checkbox]')).toBeNull();
    type(el.querySelector('textarea')!, 'הלקוח ביקש');
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('button[type=submit]')!.click();
    const req = http.expectOne('/api/admin/orders/100003/cancel');
    expect(req.request.body).toEqual({ refund: 'none', reason: 'הלקוח ביקש', restock: false });
    req.flush(DETAIL);
    await settle(fixture);
  });

  it('refund dialog: amount in shekels up to the refundable amount, and a reason', async () => {
    const fixture = mount(RefundDialog, { number: 100002, refundable: 50_000 });
    const el = fixture.nativeElement as HTMLElement;
    const submit = () => el.querySelector<HTMLButtonElement>('button[type=submit]')!;
    expect(submit().textContent).toContain('ביצוע החזר');
    type(el.querySelector('input[name=amount]')!, '500.01');
    type(el.querySelector('textarea')!, 'פגם בבד');
    fixture.detectChanges();
    expect(submit().disabled).toBe(true);
    type(el.querySelector('input[name=amount]')!, '120.5');
    fixture.detectChanges();
    submit().click();
    const req = http.expectOne('/api/admin/orders/100002/refunds');
    expect(req.request.body).toEqual({ amount: 12_050, reason: 'פגם בבד' });
    req.flush(DETAIL);
    await settle(fixture);
    expect(close).toHaveBeenCalledWith(DETAIL);
  });
});

describe('status timeline', () => {
  const setup = (inputs: Record<string, unknown>) => {
    TestBed.configureTestingModule({});
    const fixture = TestBed.createComponent(StatusTimeline);
    for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
    fixture.detectChanges();
    return fixture;
  };

  it('merges status events and refunds by time, with Hebrew labels and actors', () => {
    const fixture = setup({
      events: [
        {
          fromStatus: null,
          toStatus: 'pending_payment',
          actorType: 'customer',
          actorAdminId: null,
          note: null,
          createdAt: '2026-11-09T10:00:00.000Z',
        },
        {
          fromStatus: 'paid',
          toStatus: 'processing',
          actorType: 'admin',
          actorAdminId: 7,
          note: 'התחלנו',
          createdAt: '2026-11-11T09:00:00.000Z',
        },
        {
          fromStatus: 'pending_payment',
          toStatus: 'paid',
          actorType: 'system',
          actorAdminId: null,
          note: null,
          createdAt: '2026-11-09T10:05:00.000Z',
        },
      ],
      refunds: [{ ...FAILED_REFUND, status: 'succeeded', error: null }],
      currentAdmin: { id: 7, name: 'נועה' },
      canRetry: false,
    });
    const items = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.entry')].map((e) => e.textContent!);
    expect(items).toHaveLength(4);
    expect(items[0]).toContain('ממתינה לתשלום');
    expect(items[0]).toContain('הלקוח');
    expect(items[1]).toContain('שולמה');
    expect(items[1]).toContain('המערכת');
    expect(items[2]).toContain('החזר כספי');
    expect(items[2]).toContain('בוצע');
    expect(items[2]).toContain('נועה');
    expect(items[3]).toContain('בהכנה');
    expect(items[3]).toContain('התחלנו');
    expect(items[3]).toContain('נועה');
  });

  it('a failed refund shows its status and a retry button only for staff who may cancel', () => {
    const retry = vi.fn();
    const fixture = setup({ events: [], refunds: [FAILED_REFUND], currentAdmin: null, canRetry: true });
    fixture.componentInstance.retry.subscribe(retry);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.entry')?.textContent).toContain('נכשל');
    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    expect(retry).toHaveBeenCalledWith('r1');

    fixture.componentRef.setInput('canRetry', false);
    fixture.detectChanges();
    expect(el.querySelector('button.retry')).toBeNull();
  });
});

describe('order detail actions', () => {
  let http: HttpTestingController;

  const mount = async (permissions: Permission[], order: Partial<AdminOrderDetail> = {}) => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
    const me: AdminMe = { id: 7, email: 'a@example.test', name: 'נועה', isSuperAdmin: false, permissions };
    vi.spyOn(TestBed.inject(AuthService), 'can').mockImplementation((p) => permissions.includes(p));
    vi.spyOn(TestBed.inject(AuthService), 'me').mockReturnValue(me);
    const fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100002');
    fixture.detectChanges();
    http.expectOne('/api/admin/orders/100002').flush({ ...DETAIL, ...order });
    await settle(fixture);
    return fixture;
  };

  afterEach(() => http.verify());

  const buttons = (fixture: ComponentFixture<unknown>, selector: string) => [
    ...(fixture.nativeElement as HTMLElement).querySelectorAll<HTMLButtonElement>(selector),
  ];

  it('shows one "קדם ל…" button per next status, only with orders.manage', async () => {
    const manager = await mount(['orders.manage']);
    expect(buttons(manager, 'button.advance').map((b) => b.textContent!.trim())).toEqual([
      'קדם לבהכנה',
      'קדם לאספקה מתואמת',
      'קדם לבמשלוח',
      'קדם לסופקה',
    ]);
    TestBed.resetTestingModule();
    const viewer = await mount([]);
    expect(buttons(viewer, 'button.advance')).toHaveLength(0);
    TestBed.resetTestingModule();
    const done = await mount(['orders.manage'], { nextStatuses: [] });
    expect(buttons(done, 'button.advance')).toHaveLength(0);
  });

  it('advances directly for an ordinary status and opens the slot form for delivery_scheduled', async () => {
    const fixture = await mount(['orders.manage']);
    buttons(fixture, 'button.advance')[0].click();
    http
      .expectOne('/api/admin/orders/100002/status')
      .flush({ ...DETAIL, status: 'processing', nextStatuses: ['shipped'] });
    await settle(fixture);
    expect(buttons(fixture, 'button.advance').map((b) => b.textContent!.trim())).toEqual(['קדם לבמשלוח']);

    TestBed.resetTestingModule();
    const second = await mount(['orders.manage'], {
      status: 'processing',
      nextStatuses: ['delivery_scheduled', 'shipped', 'delivered'],
    });
    const open = vi
      .spyOn(TestBed.inject(MatDialog), 'open')
      .mockReturnValue({ afterClosed: () => of(undefined) } as never);
    buttons(second, 'button.advance')[0].click();
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(SlotDialog);
    expect(open.mock.calls[0][1]?.data).toMatchObject({ number: 100002 });
  });

  it('asks before delivered and before skipping steps; nothing is sent on "ביטול"', async () => {
    const fixture = await mount(['orders.manage']);
    const answer = { value: false };
    const open = vi
      .spyOn(TestBed.inject(MatDialog), 'open')
      .mockImplementation(() => ({ afterClosed: () => of(answer.value) }) as never);

    buttons(fixture, 'button.advance')[3].click(); // delivered
    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(ConfirmDialog);
    expect(open.mock.calls[0][1]?.data).toEqual({ message: 'לסמן את ההזמנה כסופקה? אי אפשר לחזור אחורה.' });
    http.expectNone('/api/admin/orders/100002/status');

    buttons(fixture, 'button.advance')[2].click(); // shipped: skips two steps
    expect(open.mock.calls[1][1]?.data).toEqual({ message: 'לסמן את ההזמנה כבמשלוח? אי אפשר לחזור אחורה.' });
    http.expectNone('/api/admin/orders/100002/status');

    answer.value = true;
    buttons(fixture, 'button.advance')[3].click();
    const req = http.expectOne('/api/admin/orders/100002/status');
    expect(req.request.body).toEqual({ to: 'delivered' });
    req.flush({ ...DETAIL, status: 'delivered', nextStatuses: [], canCancel: false });
    await settle(fixture);
    expect(buttons(fixture, 'button.advance')).toHaveLength(0);
  });

  it('skipping to delivery_scheduled asks first, then opens the slot form', async () => {
    const fixture = await mount(['orders.manage']);
    const open = vi
      .spyOn(TestBed.inject(MatDialog), 'open')
      .mockImplementation(() => ({ afterClosed: () => of(open.mock.calls.length === 1 ? true : undefined) }) as never);
    buttons(fixture, 'button.advance')[1].click(); // paid → delivery_scheduled skips processing
    expect(open.mock.calls.map((c) => c[0])).toEqual([ConfirmDialog, SlotDialog]);
  });

  it('after 409 invalid_transition the order is reloaded so the buttons match its real status', async () => {
    const fixture = await mount(['orders.manage']);
    buttons(fixture, 'button.advance')[0].click(); // processing: one step, no question
    http
      .expectOne('/api/admin/orders/100002/status')
      .flush({ code: 'invalid_transition' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    http.expectOne('/api/admin/orders/100002').flush({ ...DETAIL, status: 'shipped', nextStatuses: ['delivered'] });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[role=alert]')?.textContent).toContain('אי אפשר לעבור לסטטוס הזה');
    expect(buttons(fixture, 'button.advance').map((b) => b.textContent!.trim())).toEqual(['קדם לסופקה']);
  });

  it('cancel and refund buttons need orders.cancel; refund also needs a refundable amount', async () => {
    const staff = await mount(['orders.manage']);
    expect(buttons(staff, 'button.cancel-order')).toHaveLength(0);
    expect(buttons(staff, 'button.refund-order')).toHaveLength(0);
    TestBed.resetTestingModule();
    const canceller = await mount(['orders.cancel']);
    expect(buttons(canceller, 'button.cancel-order')).toHaveLength(1);
    expect(buttons(canceller, 'button.refund-order')).toHaveLength(1);
    TestBed.resetTestingModule();
    const none = await mount(['orders.cancel'], { refundable: 0 });
    expect(buttons(none, 'button.refund-order')).toHaveLength(0);
    TestBed.resetTestingModule();
    const delivered = await mount(['orders.cancel'], { status: 'delivered', canCancel: false, nextStatuses: [] });
    expect(buttons(delivered, 'button.cancel-order')).toHaveLength(0);
  });

  it('shows the timeline and the attention note, and retries a failed refund through the API', async () => {
    const fixture = await mount(['orders.cancel'], {
      refunds: [FAILED_REFUND],
      needsAttention: true,
      attentionReasons: ['flagged'],
      attentionNote: 'ההחזר נכשל',
    });
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.shortage')?.textContent).toContain('ההחזר נכשל');
    expect(el.querySelector('hga-status-timeline .entry')?.textContent).toContain('נכשל');
    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    http.expectOne('/api/admin/orders/100002/refunds/r1/retry').flush({
      ...DETAIL,
      refunds: [{ ...FAILED_REFUND, status: 'succeeded', error: null }],
    });
    await settle(fixture);
    expect(el.querySelector('button.retry')).toBeNull();
    expect(el.querySelector('hga-status-timeline .entry')?.textContent).toContain('בוצע');
  });
});
