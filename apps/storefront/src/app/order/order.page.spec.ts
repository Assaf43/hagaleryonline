import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { ORDER_STATUS_LABELS_HE, PROMOTION_ENDED_MESSAGE_HE, type OrderStatus, type OrderView } from '@hg/models';
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
    statusLabelHe: ORDER_STATUS_LABELS_HE[status],
    canCancel: status === 'pending_payment',
    refundedTotal: 0,
    deliverySlot: null,
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

  it('a retry the server refuses (promotion ended) keeps the reason and offers the cart instead of the button', async () => {
    await setup(order('payment_failed', { canRetryPayment: true }));
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    http
      .expectOne((r) => r.url === `${URL}/retry-payment`)
      .flush(
        { statusCode: 409, code: 'promotion_ended', messageHe: PROMOTION_ENDED_MESSAGE_HE },
        { status: 409, statusText: 'Conflict' },
      );
    await render();
    expect(el().querySelector('[role="alert"]')!.textContent).toContain(PROMOTION_ENDED_MESSAGE_HE);
    expect(el().querySelector('button.retry')).toBeNull();
    expect(el().querySelector('a[href="/cart"]')).not.toBeNull();
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

  describe('post-payment statuses', () => {
    it.each(['processing', 'delivery_scheduled', 'shipped', 'delivered'] as const)(
      'shows the status label for %s',
      async (status) => {
        await setup(order(status));
        expect(el().querySelector('h1')?.textContent?.trim()).toBe(ORDER_STATUS_LABELS_HE[status]);
      },
    );

    it('keeps the Phase 4 headlines for paid, pending, failed and expired', async () => {
      const headlines = [
        ['paid', 'ההזמנה התקבלה ושולמה'],
        ['pending_payment', 'ממתינים לאישור התשלום…'],
        ['payment_failed', 'התשלום לא הושלם'],
        ['expired', 'זמן התשלום עבר'],
      ] as const;
      for (const [status, headline] of headlines) {
        await setup(order(status));
        expect(el().querySelector('h1')?.textContent?.trim()).toBe(headline);
        fixture.destroy();
        http.match(() => true);
        TestBed.resetTestingModule();
        vi.useRealTimers();
      }
    });

    it('shows the delivery slot with an Israel date and times, only when there is one', async () => {
      await setup(
        order('delivery_scheduled', {
          deliverySlot: { date: '2026-11-09', windowFrom: '09:00', windowTo: '13:00', state: 'proposed' },
        }),
      );
      const slot = el().querySelector('.slot')!;
      expect(slot.textContent?.replace(/\s+/g, ' ').trim()).toBe('האספקה מתואמת ל־9.11.2026 בין 09:00 ל־13:00');
      expect(slot.querySelectorAll('bdi').length).toBe(3);
      fixture.destroy();
      TestBed.resetTestingModule();
      vi.useRealTimers();
      await setup(order('processing'));
      expect(el().querySelector('.slot')).toBeNull();
    });

    it('shows the slot only while delivery is scheduled or shipped, never once cancelled or delivered', async () => {
      const deliverySlot = { date: '2026-11-09', windowFrom: '09:00', windowTo: '13:00', state: 'proposed' } as const;
      const cases = [
        ['delivery_scheduled', true],
        ['shipped', true],
        ['delivered', false],
        ['cancelled', false],
      ] as const;
      for (const [status, shown] of cases) {
        await setup(order(status, { deliverySlot }));
        expect(el().querySelector('.slot') !== null).toBe(shown);
        fixture.destroy();
        http.match(() => true);
        TestBed.resetTestingModule();
        vi.useRealTimers();
      }
    });

    it('shows the refunded amount on a cancelled order, only when above zero', async () => {
      await setup(order('cancelled', { refundedTotal: 150000 }));
      expect(el().querySelector('.refunded')?.textContent?.replace(/\s+/g, ' ').trim()).toBe('הוחזרו 1,500 ₪');
      fixture.destroy();
      TestBed.resetTestingModule();
      vi.useRealTimers();
      await setup(order('cancelled'));
      expect(el().querySelector('.refunded')).toBeNull();
    });

    it.each(['paid', 'processing', 'delivery_scheduled', 'shipped'] as const)(
      'tells a %s order to contact support, with tel and mailto links',
      async (status) => {
        await setup(order(status));
        const line = el().querySelector('.support')!;
        expect(line.textContent).toContain('לביטול ההזמנה פנו לשירות הלקוחות');
        expect(line.querySelector('a[href^="tel:"]')?.closest('bdi')?.getAttribute('dir')).toBe('ltr');
        expect(line.querySelector('a[href^="mailto:"]')?.closest('bdi')?.getAttribute('dir')).toBe('ltr');
        http.match('/api/cart');
      },
    );

    it.each(['delivered', 'cancelled', 'pending_payment', 'payment_failed'] as const)(
      'has no support line for %s',
      async (status) => {
        await setup(order(status));
        expect(el().querySelector('.support')).toBeNull();
      },
    );
  });

  describe('customer cancel', () => {
    const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
    const native = { showModal: proto.showModal, close: proto.close };
    beforeEach(() => {
      proto.showModal = function (this: HTMLDialogElement) {
        this.setAttribute('open', '');
      };
      proto.close = function (this: HTMLDialogElement) {
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
      };
    });
    afterEach(() => {
      proto.showModal = native.showModal;
      proto.close = native.close;
    });

    const cancelButton = () => el().querySelector<HTMLButtonElement>('button.cancel-order');
    const dialog = () => el().querySelector<HTMLDialogElement>('dialog')!;
    const confirm = () => dialog().querySelector<HTMLButtonElement>('button.confirm-cancel')!;
    const cancelUrl = (r: { url: string }) => r.url === `${URL}/cancel`;

    it('shows "ביטול ההזמנה" only when canCancel', async () => {
      await setup(order('pending_payment'));
      expect(cancelButton()?.textContent?.trim()).toBe('ביטול ההזמנה');
      fixture.destroy();
      http.match(() => true);
      TestBed.resetTestingModule();
      vi.useRealTimers();
      await setup(order('payment_failed'));
      expect(cancelButton()).toBeNull();
    });

    it('asks first, and "חזרה" closes the dialog without calling the API', async () => {
      await setup(order('pending_payment'));
      cancelButton()!.click();
      fixture.detectChanges();
      expect(dialog().hasAttribute('open')).toBe(true);
      expect(dialog().querySelector('h2')?.textContent?.trim()).toBe('לבטל את ההזמנה?');
      expect(confirm().textContent?.trim()).toBe('כן, לבטל');
      // The safe choice gets the initial focus, not the destructive one.
      const first = dialog().querySelector('[autofocus]');
      expect(first?.textContent?.trim()).toBe('חזרה');
      expect(confirm().hasAttribute('autofocus')).toBe(false);
      const back = Array.from(dialog().querySelectorAll('button')).find((b) => b.textContent?.trim() === 'חזרה')!;
      back.click();
      expect(dialog().hasAttribute('open')).toBe(false);
      http.expectNone(cancelUrl);
    });

    it('confirming posts the cancel with the token and reloads the view', async () => {
      await setup(order('pending_payment'));
      cancelButton()!.click();
      fixture.detectChanges();
      confirm().click();
      const req = http.expectOne(cancelUrl);
      expect(req.request.method).toBe('POST');
      expect(req.request.params.get('t')).toBe('tok');
      req.flush(null);
      await render();
      orderRequests()[0].flush(order('cancelled'));
      await render();
      expect(el().querySelector('h1')?.textContent?.trim()).toBe('ההזמנה בוטלה');
      expect(cancelButton()).toBeNull();
    });

    it('on 409 says it cannot be cancelled now and reloads the view', async () => {
      await setup(order('pending_payment'));
      cancelButton()!.click();
      fixture.detectChanges();
      confirm().click();
      http.expectOne(cancelUrl).flush({ statusCode: 409, code: 'not_cancellable' }, { status: 409, statusText: 'x' });
      await render();
      orderRequests()[0].flush(order('paid'));
      await render();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('אי אפשר לבטל את ההזמנה כעת');
      http.match('/api/cart');
    });

    it('on another error shows the generic message and keeps the view', async () => {
      await setup(order('pending_payment'));
      cancelButton()!.click();
      fixture.detectChanges();
      confirm().click();
      http.expectOne(cancelUrl).flush({ statusCode: 500 }, { status: 500, statusText: 'x' });
      await render();
      expect(el().querySelector('[role="alert"]')?.textContent).toContain('משהו השתבש. נסו שוב.');
      expect(orderRequests().length).toBe(0);
    });

    it('stops polling once the order is cancelled', async () => {
      await setup(order('pending_payment'));
      await vi.advanceTimersByTimeAsync(3000);
      orderRequests()[0].flush(order('cancelled'));
      await render();
      await vi.advanceTimersByTimeAsync(20000);
      expect(orderRequests().length).toBe(0);
    });
  });

  it('says the order was not found for a wrong token', async () => {
    await setup(404);
    expect(el().querySelector('h1')?.textContent).toContain('ההזמנה לא נמצאה');
  });
});
