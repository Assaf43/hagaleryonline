import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { of } from 'rxjs';
import type { StoreCartView, StoreCustomer, StorePendingOrder } from '@hg/models';
import { StoreSalePage } from './store-sale.page';
import type { DeliveryChoice } from './steps';

const customer: StoreCustomer = {
  id: 'c1',
  fullName: 'דנה כהן',
  phone: '0501234567',
  email: 'dana@example.test',
  emailVerified: true,
  isNew: false,
};

const line = {
  variantId: 7,
  productSlug: 'alba',
  modelName: 'ALBA',
  nameHe: 'ספה',
  optionLabels: ['בז׳'],
  image: null,
  unitPrice: 500_000,
  compareAtPrice: null,
  quantity: 1,
  lineTotal: 500_000,
  maxQuantity: 5,
  fulfillment: 'in_stock',
  leadTimeDays: 3,
  available: true,
  unavailableReason: null,
};

const cartWith = (c: StoreCustomer | null): StoreCartView =>
  ({
    lines: [line],
    itemCount: 1,
    subtotal: 500_000,
    deliveryEstimate: null,
    notices: [],
    shippingFrom: null,
    discount: { labelHe: 'הנחת קופון', amount: 50_000, source: 'coupon', code: 'X' },
    couponCode: 'X',
    customer: c,
  }) as unknown as StoreCartView;

const delivery: DeliveryChoice = {
  address: {
    localityId: 1,
    street: 'הרצל',
    houseNumber: '1',
    apartment: null,
    floor: 0,
    hasElevator: false,
    notes: null,
  },
  localityName: 'חיפה',
  method: 'curbside',
  shippingTotal: 15_000,
  saveAddress: true,
};

const flat = (text: string | null | undefined) => (text ?? '').replace(/[‎‏\s]/g, '');
const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('store sale page', () => {
  let http: HttpTestingController;

  const open = async (cart: StoreCartView | null = cartWith(customer), pending: StorePendingOrder[] = []) => {
    const fixture = TestBed.createComponent(StoreSalePage);
    fixture.detectChanges();
    const req = http.expectOne('/api/admin/store-cart');
    req.flush(cart, cart ? { status: 200, statusText: 'OK' } : { status: 204, statusText: 'No Content' });
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush(pending);
    await settle(fixture);
    return fixture;
  };
  const el = (f: ComponentFixture<unknown>) => f.nativeElement as HTMLElement;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    http.verify();
  });

  it('cannot reach delivery without a confirmed customer', async () => {
    const fixture = await open(cartWith(null));
    const buttons = [...el(fixture).querySelectorAll<HTMLButtonElement>('.step')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['מוצרים', 'לקוח', 'משלוח', 'סיכום', 'תשלום']);
    expect(buttons[1].disabled).toBe(false);
    expect(buttons[2].disabled).toBe(true);
    fixture.componentInstance.goTo('delivery');
    expect(fixture.componentInstance.step()).toBe('products');
  });

  it('shows "מכירה חדשה" always and starts a new sale on the server', async () => {
    const fixture = await open();
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart').flush(cartWith(null));
    await settle(fixture);
    expect(fixture.componentInstance.cart()?.customer).toBeNull();
    expect(fixture.componentInstance.step()).toBe('products');
  });

  const toSummary = async () => {
    const fixture = await open();
    fixture.componentInstance.delivery.set(delivery);
    fixture.componentInstance.goTo('summary');
    await settle(fixture);
    return fixture;
  };

  it('shows one discount line and the total with shipping, money and phone inside bdi', async () => {
    const fixture = await toSummary();
    const text = flat(el(fixture).textContent);
    expect(text).toContain('הנחתקופון');
    expect(text).toContain('−500₪');
    // 5,000 - 500 + 150
    expect(text).toContain('4,650₪');
    expect(el(fixture).querySelector('.totals dd.grand bdi')).not.toBeNull();
    expect(el(fixture).querySelector('bdi[dir="ltr"]')?.textContent).toBe('ALBA');
    expect(el(fixture).querySelectorAll('.totals bdi').length).toBeGreaterThanOrEqual(4);
    // The marketing checkbox is not pre-checked and "לתשלום" waits for the terms.
    expect(el(fixture).querySelector<HTMLInputElement>('input[name="marketing"]')!.checked).toBe(false);
    expect(el(fixture).querySelector<HTMLButtonElement>('.pay')!.disabled).toBe(true);
  });

  it('places the order, opens the payment page in a new tab and shows the waiting status', async () => {
    const opened = vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = await toSummary();
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    const req = http.expectOne('/api/admin/store-orders');
    expect(req.request.body).toMatchObject({
      method: 'curbside',
      acceptTerms: true,
      expectedTotal: 465_000,
      marketingConsent: false,
      saveAddress: true,
    });
    req.flush({ number: 100050, redirectUrl: 'https://pay.example.test/x' });
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    expect(opened).toHaveBeenCalledWith('https://pay.example.test/x', '_blank', 'noopener');
    expect(fixture.componentInstance.step()).toBe('status');
    expect(flat(el(fixture).querySelector('.payment-status')?.textContent)).toContain('ממתיןלתשלום');
    // The polling shows "שולם" with the order number once the order is paid.
    const polling = fixture.componentInstance.poll();
    http.expectOne('/api/admin/store-orders/100050').flush({ number: 100050, status: 'paid', total: 465_000 });
    await polling;
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
    expect(flat(el(fixture).querySelector('.payment-status')?.textContent)).toBe('שולם·הזמנה100050');
  });

  it('offers "נסה שוב" when the payment failed or expired', async () => {
    const fixture = await toSummary();
    fixture.componentInstance.orderNumber.set(100051);
    fixture.componentInstance.goTo('status');
    const polling = fixture.componentInstance.poll();
    http.expectOne('/api/admin/store-orders/100051').flush({ number: 100051, status: 'payment_failed', total: 1 });
    await polling;
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
    expect(el(fixture).querySelector('.payment-status')?.textContent).toContain('התשלום לא הושלם');
    expect(el(fixture).querySelector('.retry')?.textContent).toContain('נסה שוב');
  });

  it('offers only a new sale (no retry) for an expired or cancelled order', async () => {
    const fixture = await toSummary();
    fixture.componentInstance.orderNumber.set(100052);
    fixture.componentInstance.goTo('status');
    const polling = fixture.componentInstance.poll();
    http.expectOne('/api/admin/store-orders/100052').flush({ number: 100052, status: 'expired', total: 1 });
    await polling;
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
    expect(el(fixture).querySelector('.payment-status')?.textContent).toContain('התחילו מכירה חדשה');
    expect(el(fixture).querySelector('.retry')).toBeNull();
  });

  it('shows an error from a failed new sale on any step', async () => {
    const fixture = await open();
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    http
      .expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart')
      .flush({ statusCode: 500 }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);
    expect(fixture.componentInstance.step()).toBe('products');
    expect(el(fixture).querySelector('p.error[role="alert"]')).not.toBeNull();
  });

  it('returns to the customer step when the API says customer_not_confirmed', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = await toSummary();
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    http
      .expectOne('/api/admin/store-orders')
      .flush({ statusCode: 409, code: 'customer_not_confirmed' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    http.expectOne('/api/admin/store-cart').flush(cartWith(null));
    await settle(fixture);
    expect(fixture.componentInstance.step()).toBe('customer');
  });

  it('shows the existing order with a retry when the sale already has one (order_pending)', async () => {
    const fixture = await toSummary();
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    http
      .expectOne('/api/admin/store-orders')
      .flush({ statusCode: 409, code: 'order_pending', number: 100060 }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    expect(fixture.componentInstance.step()).toBe('status');
    expect(fixture.componentInstance.orderNumber()).toBe(100060);
    expect(el(fixture).querySelector('.retry')).not.toBeNull();
    fixture.componentInstance['stopPolling']();
  });

  it('lists pending orders with the buttons the server allows, and cancels after a confirmation', async () => {
    const pending: StorePendingOrder[] = [
      {
        number: 100070,
        fullName: 'רון לוי',
        total: 100_000,
        status: 'payment_failed',
        reservedUntil: '2026-11-16T10:00:00.000Z',
        actions: ['retry', 'cancel'],
      },
      {
        number: 100071,
        fullName: 'נועה',
        total: 200_000,
        status: 'pending_payment',
        reservedUntil: '2026-11-16T10:00:00.000Z',
        actions: ['cancel'],
      },
    ];
    vi.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(true) } as never);
    const fixture = await open(cartWith(customer), pending);
    const rows = [...el(fixture).querySelectorAll('hga-pending-orders .card')];
    expect(rows).toHaveLength(2);
    expect([...rows[0].querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['נסה שוב', 'בטל']);
    expect([...rows[1].querySelectorAll('button')].map((b) => b.textContent?.trim())).toEqual(['בטל']);
    rows[1].querySelector('button')!.click();
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/100071/cancel').flush({ number: 100071, status: 'cancelled', total: 1 });
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush([]);
  });
});
