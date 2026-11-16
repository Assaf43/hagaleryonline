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
  marketingStatus: null,
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
  memberPrice: null,
  atMemberPrice: false,
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
    pricing: 'regular',
    memberSavings: null,
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

  const confirmWith = (answer: boolean) =>
    vi.spyOn(TestBed.inject(MatDialog), 'open').mockReturnValue({ afterClosed: () => of(answer) } as never);

  it('asks before "מכירה חדשה" when the sale has lines or a customer, then starts it on the server', async () => {
    const dialog = confirmWith(true);
    const fixture = await open();
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    await settle(fixture);
    expect(dialog).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        data: { message: 'להתחיל מכירה חדשה? העגלה והלקוח של המכירה הנוכחית יימחקו.' },
      }),
    );
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart').flush(cartWith(null));
    await settle(fixture);
    expect(fixture.componentInstance.cart()?.customer).toBeNull();
    expect(fixture.componentInstance.step()).toBe('products');
  });

  it('keeps the sale when the new-sale question is answered no', async () => {
    confirmWith(false);
    const fixture = await open();
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    await settle(fixture);
    http.expectNone((r) => r.method === 'POST' && r.url === '/api/admin/store-cart');
    expect(fixture.componentInstance.cart()?.customer).not.toBeNull();
  });

  it('asks nothing for "מכירה חדשה" when the cart is empty or the sale is locked', async () => {
    const dialog = confirmWith(true);
    const empty = { ...cartWith(null), lines: [], itemCount: 0 } as unknown as StoreCartView;
    const fixture = await open(empty);
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    await settle(fixture);
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart').flush(cartWith(null));
    await settle(fixture);
    expect(dialog).not.toHaveBeenCalled();

    fixture.componentInstance.cart.set(cartWith(customer));
    fixture.componentInstance.locked.set(true);
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    await settle(fixture);
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart').flush(cartWith(null));
    await settle(fixture);
    expect(dialog).not.toHaveBeenCalled();
  });

  it('starts a sale by itself when there is no open cart (204), so the first product can be added', async () => {
    const fixture = TestBed.createComponent(StoreSalePage);
    fixture.detectChanges();
    http.expectOne('/api/admin/store-cart').flush(null, { status: 204, statusText: 'No Content' });
    await settle(fixture);
    http.expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart').flush(cartWith(null));
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
    await settle(fixture);
    expect(fixture.componentInstance.cart()).not.toBeNull();
    expect(el(fixture).querySelector('hga-product-picker')).not.toBeNull();
  });

  it('ignores a status answer for an order that is no longer the open one', async () => {
    const fixture = await open();
    const page = fixture.componentInstance;
    page.orderNumber.set(100080);
    const stale = page.poll();
    const request = http.expectOne('/api/admin/store-orders/100080');
    // The seller taps "נסה שוב" on another order of the pending list meanwhile.
    page.orderNumber.set(100081);
    request.flush({ number: 100080, status: 'paid', total: 1 });
    await stale;
    await settle(fixture);
    expect(page.payment()).toBe('waiting');
    http.expectNone('/api/admin/store-orders/pending');
  });

  it('ignores a failed status check for an order that is no longer the open one, and a new sale clears the flag', async () => {
    const fixture = await open();
    const page = fixture.componentInstance;
    page.orderNumber.set(100082);
    const stale = page.poll();
    const request = http.expectOne('/api/admin/store-orders/100082');
    page.orderNumber.set(null);
    request.flush({ statusCode: 500 }, { status: 500, statusText: 'Server Error' });
    await stale;
    await settle(fixture);
    expect(el(fixture).querySelector('p.error[role="alert"]')).toBeNull();
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

  it('marks a line priced at the member price in the summary, with its unit price (CLB-03)', async () => {
    const memberCart = {
      ...cartWith(customer),
      pricing: 'member',
      lines: [{ ...line, unitPrice: 450_000, atMemberPrice: true, lineTotal: 450_000 }],
    } as unknown as StoreCartView;
    const fixture = await open(memberCart);
    fixture.componentInstance.delivery.set(delivery);
    fixture.componentInstance.goTo('summary');
    await settle(fixture);
    const tag = el(fixture).querySelector('.summary-lines .member-price')!;
    expect(tag.textContent).toContain('מחיר מועדון:');
    expect(tag.querySelector('bdi')!.textContent).toContain('4,500');
  });

  describe('marketing consent by SMS (CLB-08)', () => {
    const toSummaryWith = async (c: StoreCustomer) => {
      const fixture = await open(cartWith(c));
      fixture.componentInstance.delivery.set(delivery);
      fixture.componentInstance.goTo('summary');
      await settle(fixture);
      return fixture;
    };
    const box = (f: ComponentFixture<unknown>) => el(f).querySelector<HTMLInputElement>('input[name="marketing"]')!;

    it('the box is disabled without an e-mail, with a hint why', async () => {
      // The customer step already requires an e-mail to go on; the summary still guards the box itself.
      const fixture = await toSummaryWith(customer);
      fixture.componentInstance.cart.set(cartWith({ ...customer, email: null }));
      fixture.detectChanges();
      expect(box(fixture).disabled).toBe(true);
      expect(flat(el(fixture).textContent)).toContain(flat('אין כתובת דוא״ל, לכן אי אפשר להציע דיוור'));
    });

    it('a subscribed e-mail shows a checked, disabled box and sends no consent', async () => {
      const opened = vi.spyOn(window, 'open').mockReturnValue(null);
      const fixture = await toSummaryWith({ ...customer, marketingStatus: 'subscribed' });
      expect(box(fixture).checked).toBe(true);
      expect(box(fixture).disabled).toBe(true);
      expect(flat(el(fixture).textContent)).toContain(flat('כבר רשום לדיוור'));
      fixture.componentInstance['acceptTerms'].set(true);
      fixture.detectChanges();
      el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
      const req = http.expectOne('/api/admin/store-orders');
      expect(req.request.body.marketingConsent).toBe(false);
      req.flush({ number: 100060, redirectUrl: 'https://pay.example.test/x' });
      await settle(fixture);
      http.expectOne('/api/admin/store-orders/pending').flush([]);
      expect(opened).toHaveBeenCalled();
      expect(flat(el(fixture).textContent)).not.toContain(flat('נשלח ללקוח SMS לאישור הדיוור'));
    });

    it('a pending contact shows a hint that confirmation is still waiting', async () => {
      const fixture = await toSummaryWith({ ...customer, marketingStatus: 'pending' });
      expect(box(fixture).disabled).toBe(false);
      expect(flat(el(fixture).textContent)).toContain(flat('אישור הדיוור עדיין ממתין ללקוח'));
    });

    it('after an order with the box ticked, the status step says the SMS was sent', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      const fixture = await toSummaryWith(customer);
      box(fixture).click();
      fixture.componentInstance['acceptTerms'].set(true);
      fixture.detectChanges();
      el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
      const req = http.expectOne('/api/admin/store-orders');
      expect(req.request.body.marketingConsent).toBe(true);
      req.flush({ number: 100061, redirectUrl: 'https://pay.example.test/x', consentSmsSent: true });
      await settle(fixture);
      http.expectOne('/api/admin/store-orders/pending').flush([]);
      await settle(fixture);
      expect(flat(el(fixture).textContent)).toContain(flat('נשלח ללקוח SMS לאישור הדיוור'));
    });

    it('the box ticked but no SMS sent (already subscribed meanwhile, or the daily limit): no SMS claim', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      const fixture = await toSummaryWith(customer);
      box(fixture).click();
      fixture.componentInstance['acceptTerms'].set(true);
      fixture.detectChanges();
      el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
      const req = http.expectOne('/api/admin/store-orders');
      expect(req.request.body.marketingConsent).toBe(true);
      req.flush({ number: 100063, redirectUrl: 'https://pay.example.test/x', consentSmsSent: false });
      await settle(fixture);
      http.expectOne('/api/admin/store-orders/pending').flush([]);
      await settle(fixture);
      expect(flat(el(fixture).textContent)).not.toContain(flat('נשלח ללקוח SMS לאישור הדיוור'));
    });

    it('without the tick the status step does not mention it', async () => {
      vi.spyOn(window, 'open').mockReturnValue(null);
      const fixture = await toSummaryWith(customer);
      fixture.componentInstance['acceptTerms'].set(true);
      fixture.detectChanges();
      el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
      http.expectOne('/api/admin/store-orders').flush({ number: 100062, redirectUrl: 'https://pay.example.test/x' });
      await settle(fixture);
      http.expectOne('/api/admin/store-orders/pending').flush([]);
      await settle(fixture);
      expect(flat(el(fixture).textContent)).not.toContain(flat('נשלח ללקוח SMS לאישור הדיוור'));
    });
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
    expect(opened).toHaveBeenCalledWith('https://pay.example.test/x', '_blank');
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

  const payNow = async (fixture: ComponentFixture<StoreSalePage>) => {
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    http.expectOne('/api/admin/store-orders').flush({ number: 100090, redirectUrl: 'https://pay.example.test/z' });
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
  };

  it('shows a prominent "פתיחת דף התשלום" button when the browser blocked the payment tab', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = await toSummary();
    await payNow(fixture);
    const link = el(fixture).querySelector<HTMLAnchorElement>('a.open-pay')!;
    expect(link.textContent).toContain('פתיחת דף התשלום');
    expect(link.getAttribute('href')).toBe('https://pay.example.test/z');
    expect(link.rel).toContain('noopener');
    expect(flat(el(fixture).textContent)).not.toContain('נפתחבלשוניתחדשה.');
    fixture.componentInstance['stopPolling']();
  });

  it('keeps the "opened in a new tab" copy when the tab opened, and cuts the opener link', async () => {
    const tab = { opener: {} } as unknown as Window;
    vi.spyOn(window, 'open').mockReturnValue(tab);
    const fixture = await toSummary();
    await payNow(fixture);
    expect(el(fixture).querySelector('a.open-pay')).toBeNull();
    expect(flat(el(fixture).textContent)).toContain('דףהתשלוםנפתחבלשוניתחדשה.');
    expect(tab.opener).toBeNull();
    fixture.componentInstance['stopPolling']();
  });

  it('shows the e-mail the confirmation goes to inside bdi', async () => {
    const fixture = await toSummary();
    const mail = [...el(fixture).querySelectorAll('bdi[dir="ltr"]')].find((b) => b.textContent === customer.email);
    expect(mail).toBeDefined();
    expect(flat(mail!.parentElement?.textContent)).toContain('אישורההזמנהיישלחאל');
  });

  it('goes back to the delivery step when price_changed came with different cart lines', async () => {
    const fixture = await toSummary();
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    http
      .expectOne('/api/admin/store-orders')
      .flush({ statusCode: 409, code: 'price_changed' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    const changed = { ...cartWith(customer), lines: [{ ...line, quantity: 2, lineTotal: 1_000_000 }] };
    http.expectOne('/api/admin/store-cart').flush(changed);
    await settle(fixture);
    await settle(fixture);
    expect(fixture.componentInstance.delivery()).toBeNull();
    expect(fixture.componentInstance.step()).toBe('delivery');
    // The delivery step loads the customer's saved addresses.
    http.expectOne('/api/admin/store-cart/customer/addresses').flush([]);
  });

  it('keeps the delivery choice when price_changed left the cart lines as they were', async () => {
    const fixture = await toSummary();
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    http
      .expectOne('/api/admin/store-orders')
      .flush({ statusCode: 409, code: 'price_changed' }, { status: 409, statusText: 'Conflict' });
    await settle(fixture);
    http.expectOne('/api/admin/store-cart').flush(cartWith(customer));
    await settle(fixture);
    expect(fixture.componentInstance.delivery()).not.toBeNull();
    expect(fixture.componentInstance.step()).toBe('summary');
  });

  const failedOrder = (number: number): StorePendingOrder => ({
    number,
    fullName: 'רון לוי',
    total: 100_000,
    status: 'payment_failed',
    reservedUntil: '2026-11-16T10:00:00.000Z',
    actions: ['retry', 'cancel'],
  });

  it('retrying a pending order is not undone by the answer of the order paid a moment ago', async () => {
    const pending = [failedOrder(100095)];
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = await open(cartWith(customer), pending);
    const page = fixture.componentInstance;
    // Order A was just paid in the other tab; its check is in flight when the seller retries order B.
    page.orderNumber.set(100094);
    const checkA = page.poll();
    const requestA = http.expectOne('/api/admin/store-orders/100094');
    el(fixture).querySelector<HTMLButtonElement>('hga-pending-orders .card button')!.click();
    await settle(fixture);
    http
      .expectOne('/api/admin/store-orders/100095/retry')
      .flush({ number: 100095, redirectUrl: 'https://pay.example.test/b' });
    await settle(fixture);
    requestA.flush({ number: 100094, status: 'paid', total: 1 });
    await checkA;
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush(pending);
    expect(page.orderNumber()).toBe(100095);
    expect(page.payment()).toBe('waiting');
    expect(flat(el(fixture).querySelector('.payment-status')?.textContent)).toContain('ממתיןלתשלום');
    page['stopPolling']();
  });

  it('disables the pending-list buttons while a request is running', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = await open(cartWith(customer), [failedOrder(100096)]);
    const buttons = () => [...el(fixture).querySelectorAll<HTMLButtonElement>('hga-pending-orders button')];
    buttons()[0].click();
    fixture.detectChanges();
    expect(buttons().every((b) => b.disabled)).toBe(true);
    http.expectOne('/api/admin/store-orders/100096/retry').flush({ number: 100096, redirectUrl: 'https://p.test/x' });
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    fixture.componentInstance['stopPolling']();
  });

  it('shows an error from a failed new sale on any step', async () => {
    confirmWith(true);
    const fixture = await open();
    el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.click();
    await settle(fixture);
    http
      .expectOne((r) => r.method === 'POST' && r.url === '/api/admin/store-cart')
      .flush({ statusCode: 500 }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);
    expect(fixture.componentInstance.step()).toBe('products');
    expect(el(fixture).querySelector('p.error[role="alert"]')).not.toBeNull();
  });

  it('polls at once when the tab becomes visible, never twice at the same time, and clears a poll error', async () => {
    const fixture = await toSummary();
    const page = fixture.componentInstance;
    page.orderNumber.set(100053);
    page['startPolling']();
    document.dispatchEvent(new Event('visibilitychange'));
    const first = http.expectOne('/api/admin/store-orders/100053');
    // The pending list is refreshed on the same event (M5), once while one refresh is in flight.
    const pendingFirst = http.expectOne('/api/admin/store-orders/pending');
    // A second trigger while the first is in flight sends nothing.
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectNone('/api/admin/store-orders/100053');
    http.expectNone('/api/admin/store-orders/pending');
    pendingFirst.flush([]);
    first.flush({ statusCode: 500 }, { status: 500, statusText: 'Server Error' });
    await settle(fixture);
    expect(el(fixture).querySelector('p.error[role="alert"]')).not.toBeNull();
    document.dispatchEvent(new Event('visibilitychange'));
    http.expectOne('/api/admin/store-orders/100053').flush({ number: 100053, status: 'pending_payment', total: 1 });
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
    expect(el(fixture).querySelector('p.error[role="alert"]')).toBeNull();
    page['stopPolling']();
  });

  it('locks steps 1-4 once the order exists, leaving the status step', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const fixture = await toSummary();
    fixture.componentInstance['acceptTerms'].set(true);
    fixture.detectChanges();
    el(fixture).querySelector<HTMLButtonElement>('.pay')!.click();
    http.expectOne('/api/admin/store-orders').flush({ number: 100054, redirectUrl: 'https://pay.example.test/y' });
    await settle(fixture);
    http.expectOne('/api/admin/store-orders/pending').flush([]);
    await settle(fixture);
    const buttons = [...el(fixture).querySelectorAll<HTMLButtonElement>('.step')];
    expect(buttons.map((b) => b.disabled)).toEqual([true, true, true, true, false]);
    expect(el(fixture).querySelector<HTMLButtonElement>('.new-sale')!.disabled).toBe(false);
    fixture.componentInstance['stopPolling']();
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
