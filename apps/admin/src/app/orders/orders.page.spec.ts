import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import {
  ORDER_STATUS_LABELS_HE,
  type AdminOrderDetail,
  type AdminOrderPage,
  type Permission,
  type ProvidersStatus,
} from '@hg/models';
import { AuthService } from '../core/auth.service';
import { ProvidersPage } from '../settings/providers.page';
import { OrderDetailPage } from './order-detail.page';
import { OrdersPage } from './orders.page';

const PAGE: AdminOrderPage = {
  items: [
    {
      number: 100002,
      createdAt: '2026-11-09T10:00:00.000Z',
      customerName: 'דנה כהן',
      phone: '0501234567',
      total: 115_000,
      status: 'paid',
      itemCount: 2,
      needsAttention: true,
      attentionReasons: ['paid_twice'],
    },
    {
      number: 100001,
      createdAt: '2026-11-08T10:00:00.000Z',
      customerName: 'רון לוי',
      phone: '0527654321',
      total: 50_000,
      status: 'expired',
      itemCount: 1,
      needsAttention: false,
      attentionReasons: [],
    },
  ],
  total: 2,
  page: 1,
  pageSize: 30,
};

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
    apartment: '4',
    floor: 2,
    hasElevator: true,
    notes: 'להתקשר לפני',
  },
  method: 'curbside',
  shippingTotal: 15_000,
  shippingLines: [{ labelHe: 'הובלה', amount: 15_000 }],
  subtotal: 100_000,
  discount: 0,
  discountInfo: null,
  total: 115_000,
  deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 3 },
  lines: [
    {
      variantId: 1,
      sku: 'ALBA-BEIGE',
      modelName: 'ALBA',
      nameHe: 'ספה תלת־מושבית',
      optionLabels: ['בז׳'],
      unitPrice: 50_000,
      quantity: 2,
      lineTotal: 100_000,
    },
  ],
  stockShortage: true,
  refundedTotal: 0,
  refundable: 0,
  attentionNote: null,
  refunds: [],
  deliverySlot: null,
  canCancel: true,
  nextStatuses: [],
  statusEvents: [],
  invoices: [],
  needsAttention: true,
  attentionReasons: ['stock_shortage', 'amount_mismatch'],
  paymentProvider: 'sandbox',
  shippingProvider: 'manual',
  payments: [
    {
      provider: 'sandbox',
      transactionId: 'sbx_abc',
      status: 'succeeded',
      installments: 3,
      amount: 115_000,
      rawStatus: 'amount_mismatch',
      createdAt: '2026-11-09T10:01:00.000Z',
    },
  ],
};

/** Text without the bidi marks and spaces the currency formatter adds. */
const flat = (text: string | null | undefined) => (text ?? '').replace(/[‎‏\s]/g, '');

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('admin orders screens', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('lists the orders with their Hebrew status and links to the detail', async () => {
    const fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    http
      .expectOne((r) => r.url === '/api/admin/orders' && r.params.get('page') === '1' && !r.params.has('status'))
      .flush(PAGE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.order')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('דנה כהן');
    expect(rows[0].textContent).toContain('שולמה');
    expect(flat(rows[0].textContent)).toContain('1,150₪');
    expect(rows[1].textContent).toContain('פג תוקף');
    expect(rows[0].querySelector('a')?.getAttribute('href')).toBe('/orders/100002');
    // One item reads "פריט אחד", more read "N פריטים".
    expect(rows[0].querySelector('.items')?.textContent).toBe('2 פריטים');
    expect(rows[1].querySelector('.items')?.textContent).toBe('פריט אחד');
    // The marker has text, not only color, and says why for screen readers.
    expect(rows[0].querySelector('.attention')?.textContent).toContain('דורשת טיפול');
    expect(rows[0].querySelector('.attention')?.textContent).toContain('שולמה פעמיים');
    expect(rows[1].querySelector('.attention')).toBeNull();
  });

  it('offers a filter for every order status', async () => {
    const fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/orders?page=1').flush(PAGE);
    await settle(fixture);
    const labels = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.filter:not(.attention-filter)')].map(
      (b) => b.textContent?.trim(),
    );
    expect(labels).toEqual(['הכול', ...Object.values(ORDER_STATUS_LABELS_HE)]);
  });

  it('puts the chosen filter and page in the URL and loads what the URL says', async () => {
    const navigate = vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
    const fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/orders?page=1').flush({ ...PAGE, total: 70 });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = [...el.querySelectorAll<HTMLButtonElement>('.filter')].find((b) =>
      b.textContent?.includes('התשלום נכשל'),
    )!;
    button.click();
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { status: 'payment_failed', attention: null, page: null },
    });
    el.querySelector<HTMLButtonElement>('.attention-filter')!.click();
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { status: null, attention: 'true', page: null },
    });
    el.querySelectorAll<HTMLButtonElement>('.pager button')[1].click();
    expect(navigate).toHaveBeenLastCalledWith([], {
      relativeTo: expect.anything(),
      queryParams: { status: null, attention: null, page: 2 },
    });

    // The router binds the query parameters (back and forward too): the page loads what they say.
    fixture.componentRef.setInput('status', 'payment_failed');
    fixture.componentRef.setInput('attention', 'true');
    fixture.componentRef.setInput('page', '2');
    fixture.detectChanges();
    http
      .expectOne(
        (r) =>
          r.params.get('status') === 'payment_failed' &&
          r.params.get('page') === '2' &&
          r.params.get('attention') === 'true',
      )
      .flush({ ...PAGE, items: [], total: 0 });
    await settle(fixture);
    const pressed = [...el.querySelectorAll('.filter')]
      .filter((b) => b.getAttribute('aria-pressed') === 'true')
      .map((b) => b.textContent?.trim());
    expect(pressed).toEqual(['התשלום נכשל', 'דורשות טיפול']);
    expect(el.querySelector('.empty')?.textContent).toContain('אין הזמנות');
  });

  it('ignores a slow answer of an earlier filter that arrives after the newer one', async () => {
    const fixture = TestBed.createComponent(OrdersPage);
    fixture.componentRef.setInput('status', 'paid');
    fixture.detectChanges();
    const slow = http.expectOne((r) => r.params.get('status') === 'paid');
    fixture.componentRef.setInput('status', 'expired');
    fixture.detectChanges();
    const fast = http.expectOne((r) => r.params.get('status') === 'expired');
    fast.flush({ ...PAGE, items: [PAGE.items[1]], total: 1 });
    await settle(fixture);
    slow.flush({ ...PAGE, items: [PAGE.items[0]], total: 1 });
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.order')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('רון לוי');
    expect(el.querySelector('ul')?.getAttribute('aria-busy')).toBe('false');
  });

  it('a failed load of a new filter does not leave the old filter rows on screen, and can be retried', async () => {
    const fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/orders?page=1').flush(PAGE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.order')).toHaveLength(2);
    fixture.componentRef.setInput('status', 'paid');
    fixture.detectChanges();
    http
      .expectOne((r) => r.params.get('status') === 'paid')
      .flush({ code: 'x' }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);
    expect(el.querySelectorAll('.order')).toHaveLength(0);
    expect(el.querySelector('[role=alert]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('[role=alert] button')!.click();
    http.expectOne((r) => r.params.get('status') === 'paid').flush(PAGE);
    await settle(fixture);
    expect(el.querySelectorAll('.order')).toHaveLength(2);
  });

  it('shows lines, address, totals and payments of one order, and flags a stock shortage', async () => {
    const fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100002');
    fixture.detectChanges();
    http.expectOne('/api/admin/orders/100002').flush(DETAIL);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('h1')?.textContent).toContain('100002');
    expect(el.querySelector('.shortage')?.textContent).toContain('נדרש טיפול');
    expect(el.querySelector('.shortage')?.textContent).toContain('סכום התשלום לא תואם');
    const line = el.querySelector('.line')!;
    expect(line.querySelector('bdi[dir="ltr"]')?.textContent).toBe('ALBA');
    expect(flat(line.textContent)).toContain('2×500₪');
    const text = el.textContent!;
    expect(text).toContain('הרצל 1');
    expect(text).toContain('תל אביב - יפו');
    expect(text).toContain('להתקשר לפני');
    expect(flat(text)).toContain('1,150₪');
    // The method in the customer's own words (the storefront shows the same name).
    expect(text).toContain('משלוח (עד נקודת הפריקה)');
    const payment = el.querySelector('.payment')!;
    expect(payment.textContent).toContain('הצליח');
    expect(payment.textContent).toContain('3 תשלומים');
    expect(payment.querySelector('.pay-flag')?.textContent).toContain('סכום לא תואם');
    expect(payment.textContent).toContain('sbx_abc');
  });

  it('shows the discount with the minus at the left of the digits (R20)', async () => {
    const fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100002');
    fixture.detectChanges();
    http.expectOne('/api/admin/orders/100002').flush({
      ...DETAIL,
      discount: 15_000,
      discountInfo: { labelHe: 'קופון חורף', source: 'coupon', code: 'WINTER' },
      total: 100_000,
    });
    await settle(fixture);
    const amount = (fixture.nativeElement as HTMLElement).querySelector('.discount-amount')!;
    expect(amount.querySelector('bdi[dir="ltr"]')?.textContent).toBe('−150');
    expect(amount.textContent?.replace(/\s+/g, ' ').trim()).toBe('−150 ₪');
  });

  it('shows no shortage notice for an ordinary order and a message for an unknown one', async () => {
    const fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100002');
    fixture.detectChanges();
    http
      .expectOne('/api/admin/orders/100002')
      .flush({ ...DETAIL, stockShortage: false, needsAttention: false, attentionReasons: [] });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('.shortage')).toBeNull();

    const missing = TestBed.createComponent(OrderDetailPage);
    missing.componentRef.setInput('number', '999999');
    missing.detectChanges();
    http.expectOne('/api/admin/orders/999999').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await settle(missing);
    expect((missing.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain('לא נמצאה');
  });

  it('shows a loading state while the order loads, and one installment as "תשלום אחד"', async () => {
    const fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100002');
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('[role=status]')?.textContent).toContain('טוען');
    http
      .expectOne('/api/admin/orders/100002')
      .flush({ ...DETAIL, payments: [{ ...DETAIL.payments[0], installments: 1, rawStatus: 'ok-123' }] });
    await settle(fixture);
    expect(el.querySelector('[aria-busy]')?.getAttribute('aria-busy')).toBe('false');
    expect(el.querySelector('[role=status]')).toBeNull();
    expect(el.querySelector('.payment')?.textContent).toContain('תשלום אחד');
    expect(el.querySelector('.payment')?.textContent).toContain('ok-123');
  });

  describe('documents (CHK-08)', () => {
    const INVOICES: AdminOrderDetail['invoices'] = [
      {
        id: '11111111-1111-4111-8111-111111111111',
        type: 'tax_invoice_receipt',
        number: 'MOCK-INV-000042',
        issuedAt: '2026-11-09T10:05:00.000Z',
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        type: 'credit_note',
        number: 'MOCK-CN-000007',
        issuedAt: '2026-11-10T09:00:00.000Z',
      },
    ];
    const mount = async (permissions: Permission[], invoices = INVOICES) => {
      vi.spyOn(TestBed.inject(AuthService), 'can').mockImplementation((p) => permissions.includes(p));
      const fixture = TestBed.createComponent(OrderDetailPage);
      fixture.componentRef.setInput('number', '100002');
      fixture.detectChanges();
      http.expectOne('/api/admin/orders/100002').flush({ ...DETAIL, invoices });
      await settle(fixture);
      return fixture.nativeElement as HTMLElement;
    };

    it('lists the documents with links to the admin document endpoint (invoices.export)', async () => {
      const el = await mount(['orders.view', 'invoices.export']);
      const section = el.querySelector('.documents')!;
      expect(section.querySelector('h2')?.textContent?.trim()).toBe('מסמכים');
      const links = [...section.querySelectorAll<HTMLAnchorElement>('a')];
      expect(links.map((a) => a.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
        'חשבונית מס/קבלה MOCK-INV-000042',
        'חשבונית זיכוי MOCK-CN-000007',
      ]);
      expect(links[0].getAttribute('href')).toBe('/api/admin/invoices/11111111-1111-4111-8111-111111111111/document');
      expect(links[1].getAttribute('href')).toBe('/api/admin/invoices/22222222-2222-4222-8222-222222222222/document');
      for (const a of links) {
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toBe('noopener');
        expect(a.querySelector('bdi')?.textContent).toMatch(/^MOCK-/);
      }
      expect(section.textContent).toContain('9.11.2026');
    });

    it('without invoices.export shows the documents as text, without links', async () => {
      const el = await mount(['orders.view']);
      const section = el.querySelector('.documents')!;
      expect(section.querySelectorAll('a')).toHaveLength(0);
      expect(section.textContent).toContain('MOCK-INV-000042');
    });

    it('says when there are no documents yet', async () => {
      const el = await mount(['orders.view', 'invoices.export'], []);
      expect(el.querySelector('.documents')?.textContent).toContain('אין מסמכים');
    });
  });

  it('providers page shows the test-mode badge only in test mode', async () => {
    const show = async (status: ProvidersStatus) => {
      const fixture = TestBed.createComponent(ProvidersPage);
      fixture.detectChanges();
      http.expectOne('/api/admin/providers').flush(status);
      await settle(fixture);
      return fixture.nativeElement as HTMLElement;
    };
    const test = await show({ payment: { code: 'sandbox', testMode: true }, shipping: { code: 'manual' } });
    expect(test.querySelector('.badge')?.textContent?.trim()).toBe('מצב בדיקה');
    expect(test.textContent).toContain('sandbox');
    expect(test.textContent).toContain('manual');
    const live = await show({ payment: { code: 'acme', testMode: false }, shipping: { code: 'manual' } });
    expect(live.querySelector('.badge')).toBeNull();
  });
});
