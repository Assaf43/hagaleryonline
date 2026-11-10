import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { AdminOrderDetail, AdminOrderPage, ProvidersStatus } from '@hg/models';
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
    },
    {
      number: 100001,
      createdAt: '2026-11-08T10:00:00.000Z',
      customerName: 'רון לוי',
      phone: '0527654321',
      total: 50_000,
      status: 'expired',
      itemCount: 1,
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
  paymentProvider: 'sandbox',
  shippingProvider: 'manual',
  payments: [
    {
      provider: 'sandbox',
      transactionId: 'sbx_abc',
      status: 'succeeded',
      installments: 3,
      amount: 115_000,
      rawStatus: 'succeeded',
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
  });

  it('reloads from page 1 with the chosen status filter', async () => {
    const fixture = TestBed.createComponent(OrdersPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/orders?page=1').flush(PAGE);
    await settle(fixture);
    const el = fixture.nativeElement as HTMLElement;
    const button = [...el.querySelectorAll<HTMLButtonElement>('.filter')].find((b) =>
      b.textContent?.includes('התשלום נכשל'),
    )!;
    button.click();
    fixture.detectChanges();
    http
      .expectOne((r) => r.params.get('status') === 'payment_failed' && r.params.get('page') === '1')
      .flush({ ...PAGE, items: [], total: 0 });
    await settle(fixture);
    expect(button.getAttribute('aria-pressed')).toBe('true');
    expect(el.querySelector('.empty')?.textContent).toContain('אין הזמנות');
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
    const line = el.querySelector('.line')!;
    expect(line.querySelector('bdi[dir="ltr"]')?.textContent).toBe('ALBA');
    expect(flat(line.textContent)).toContain('2×500₪');
    const text = el.textContent!;
    expect(text).toContain('הרצל 1');
    expect(text).toContain('תל אביב - יפו');
    expect(text).toContain('להתקשר לפני');
    expect(flat(text)).toContain('1,150₪');
    const payment = el.querySelector('.payment')!;
    expect(payment.textContent).toContain('הצליח');
    expect(payment.textContent).toContain('3 תשלומים');
    expect(payment.textContent).toContain('sbx_abc');
  });

  it('shows no shortage notice for an ordinary order and a message for an unknown one', async () => {
    const fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100002');
    fixture.detectChanges();
    http.expectOne('/api/admin/orders/100002').flush({ ...DETAIL, stockShortage: false });
    await settle(fixture);
    expect((fixture.nativeElement as HTMLElement).querySelector('.shortage')).toBeNull();

    const missing = TestBed.createComponent(OrderDetailPage);
    missing.componentRef.setInput('number', '999999');
    missing.detectChanges();
    http.expectOne('/api/admin/orders/999999').flush({ code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    await settle(missing);
    expect((missing.nativeElement as HTMLElement).querySelector('[role=alert]')?.textContent).toContain('לא נמצאה');
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
