import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { OrderStatus, OrderView } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { ExternalNavigation } from '../checkout/checkout.api';
import { OrderPage } from './order.page';

function order(status: OrderStatus, extra: Partial<OrderView> = {}): OrderView {
  return {
    number: 100001,
    status,
    createdAt: '2026-11-10T10:00:00.000Z',
    reservedUntil: '2026-11-10T10:20:00.000Z',
    lines: [
      {
        variantId: 1,
        sku: 'ALBA-1',
        modelName: 'ALBA',
        nameHe: 'ספה תלת מושבית',
        optionLabels: ['בז׳'],
        unitPrice: 300000,
        quantity: 1,
        lineTotal: 300000,
      },
    ],
    address: {
      localityId: 5000,
      localityNameHe: 'תל אביב - יפו',
      street: 'הרצל',
      houseNumber: '12',
      apartment: '5',
      floor: 3,
      hasElevator: true,
      notes: null,
    },
    method: 'full_service',
    shippingTotal: 45000,
    shippingLines: [
      { labelHe: 'משלוח', amount: 25000 },
      { labelHe: 'הרכבה', amount: 20000 },
    ],
    subtotal: 300000,
    discount: 0,
    discountInfo: null,
    total: 345000,
    deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 14 },
    canRetryPayment: false,
    stockShortage: false,
    ...extra,
  };
}

const URL = '/api/orders/100001';

describe('OrderPage', () => {
  let fixture: ComponentFixture<OrderPage>;
  let http: HttpTestingController;
  let assign: ReturnType<typeof vi.fn>;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const render = async () => {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  const orderRequests = () => http.match((r) => r.url === URL);

  async function setup(first: OrderView | 404) {
    vi.useFakeTimers();
    assign = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ExternalNavigation, useValue: { assign } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(OrderPage);
    fixture.componentRef.setInput('number', '100001');
    fixture.componentRef.setInput('t', 'tok');
    fixture.detectChanges();
    const req = http.expectOne((r) => r.url === URL);
    expect(req.request.params.get('t')).toBe('tok');
    if (first === 404) req.flush({ statusCode: 404, code: 'not_found' }, { status: 404, statusText: 'Not Found' });
    else req.flush(first);
    await render();
  }

  afterEach(() => {
    // A paid order refreshes the cart; tests that do not check that load drain it here.
    http.match('/api/cart');
    http.verify();
    vi.useRealTimers();
  });

  it('sets a noindex title without the token', async () => {
    await setup(order('paid'));
    expect(metaSet).toHaveBeenCalledWith(expect.objectContaining({ path: '/order/100001', noindex: true }));
    expect(JSON.stringify(metaSet.mock.calls)).not.toContain('tok');
    http.match('/api/cart');
  });

  it('shows a paid order with its lines, address, method, totals, estimate and number', async () => {
    await setup(order('paid'));
    expect(el().querySelector('h1')?.textContent).toContain('ההזמנה התקבלה ושולמה');
    expect(text()).toContain('שמרו את מספר ההזמנה: 100001');
    expect(text()).toContain('ALBA');
    expect(text()).toContain('ספה תלת מושבית');
    expect(text()).toContain('הרצל 12, דירה 5, תל אביב - יפו');
    expect(text()).toContain('תל אביב - יפו');
    expect(text()).toContain('כולל סבלות והרכבה');
    expect(text()).toContain('הרכבה');
    expect(text()).toContain('3,450 ₪');
    expect(text()).toContain('זמן אספקה משוער: עד 14 ימי עסקים');
    expect(el().querySelector('.retry')).toBeNull();
  });

  it('shows the order discount as "{name}: −{price}", and no discount line without one', async () => {
    await setup(
      order('paid', {
        discount: 30000,
        discountInfo: { labelHe: 'קופון חורף', source: 'coupon', code: 'WINTER' },
        total: 315000,
      }),
    );
    const row = el().querySelector('.totals .discount-row');
    expect(row?.textContent?.replace(/\s+/g, ' ').trim()).toBe('קופון חורף: −300 ₪');
    expect(row?.querySelector('bdi[dir="ltr"]')?.textContent).toBe('−300');
    expect(text()).toContain('3,150 ₪');
    fixture.destroy();
    http.match('/api/cart');
    TestBed.resetTestingModule();
    vi.useRealTimers();
    await setup(order('paid'));
    expect(el().querySelector('.discount-row')).toBeNull();
  });

  it('refreshes the cart once the order is paid', async () => {
    await setup(order('paid'));
    http.expectOne('/api/cart');
  });

  it('polls a pending order every 3 seconds until it is paid', async () => {
    await setup(order('pending_payment'));
    expect(el().querySelector('h1')?.textContent).toContain('ממתינים לאישור התשלום…');
    http.expectNone('/api/cart');
    await vi.advanceTimersByTimeAsync(2999);
    expect(orderRequests().length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    orderRequests()[0].flush(order('pending_payment'));
    await render();
    await vi.advanceTimersByTimeAsync(3000);
    orderRequests()[0].flush(order('paid'));
    await render();
    expect(el().querySelector('h1')?.textContent).toContain('ההזמנה התקבלה ושולמה');
    http.expectOne('/api/cart');
    await vi.advanceTimersByTimeAsync(10000);
    expect(orderRequests().length).toBe(0);
  });

  it('stops polling after one minute and offers to check again', async () => {
    await setup(order('pending_payment'));
    let polls = 0;
    for (let i = 0; i < 30; i++) {
      await vi.advanceTimersByTimeAsync(3000);
      for (const req of orderRequests()) {
        polls++;
        req.flush(order('pending_payment'));
      }
      await render();
    }
    expect(polls).toBe(20);
    const again = el().querySelector<HTMLButtonElement>('button.check-again')!;
    expect(again).not.toBeNull();
    again.click();
    expect(orderRequests().length).toBe(1);
  });

  it('a failed payment offers "נסו לשלם שוב", which opens a new payment page', async () => {
    await setup(order('payment_failed', { canRetryPayment: true }));
    expect(el().querySelector('h1')?.textContent).toContain('התשלום לא הושלם');
    const retry = el().querySelector<HTMLButtonElement>('button.retry')!;
    expect(retry.textContent?.trim()).toBe('נסו לשלם שוב');
    retry.click();
    const req = http.expectOne((r) => r.url === `${URL}/retry-payment`);
    expect(req.request.method).toBe('POST');
    expect(req.request.params.get('t')).toBe('tok');
    req.flush({ redirectUrl: 'http://localhost:4200/pay/sandbox/xyz' }, { status: 201, statusText: 'Created' });
    await render();
    expect(assign).toHaveBeenCalledWith('http://localhost:4200/pay/sandbox/xyz');
  });

  it('an expired order offers a retry too', async () => {
    await setup(order('expired', { canRetryPayment: true }));
    expect(el().querySelector('h1')?.textContent).toContain('זמן התשלום עבר');
    expect(el().querySelector('button.retry')?.textContent?.trim()).toBe('נסו לשלם שוב');
  });

  it('without a possible retry, sends the customer back to the cart', async () => {
    await setup(order('payment_failed'));
    expect(el().querySelector('button.retry')).toBeNull();
    expect(el().querySelector('a[href="/cart"]')).not.toBeNull();
  });

  it('explains a superseded order on retry', async () => {
    await setup(order('expired', { canRetryPayment: true }));
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    http
      .expectOne((r) => r.url === `${URL}/retry-payment`)
      .flush({ statusCode: 409, code: 'superseded' }, { status: 409, statusText: 'Conflict' });
    await render();
    const alert = el().querySelector('[role="alert"]')!;
    expect(alert.textContent).toContain('הזמנה חדשה יותר');
    expect(assign).not.toHaveBeenCalled();
  });

  it('announces only the status politely; the retry error is an alert outside that region', async () => {
    await setup(order('payment_failed', { canRetryPayment: true }));
    const live = el().querySelector('[aria-live="polite"]')!;
    expect(live.querySelector('h1')?.textContent).toContain('התשלום לא הושלם');
    expect(el().querySelectorAll('[aria-live]').length).toBe(1);
    const alert = el().querySelector('[role="alert"]')!;
    expect(live.contains(alert)).toBe(false);
    expect(live.querySelector('button')).toBeNull();
  });

  it('says the order was not found for a wrong token', async () => {
    await setup(404);
    expect(el().querySelector('h1')?.textContent).toContain('ההזמנה לא נמצאה');
  });
});
