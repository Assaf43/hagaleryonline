import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from './customer.store';
import { OrderDetailPage } from './order-detail.page';
import { failWith, orderView, provideAccountTesting, signedIn, tick } from './account.testing';

const URL = '/api/account/orders/100001';

describe('OrderDetailPage (account)', () => {
  let fixture: ComponentFixture<OrderDetailPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const button = (label: string) =>
    [...el().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(label));
  const settle = async () => {
    await tick();
    fixture.detectChanges();
  };

  async function setup(first: ReturnType<typeof orderView> | 404) {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100001');
    fixture.detectChanges();
    await tick();
    const req = http.expectOne(URL);
    if (first === 404) failWith(req, 404, 'not_found');
    else req.flush(first);
    await settle();
  }

  // jsdom has no modal dialog: a minimal stand-in that tracks `open`.
  beforeAll(() => {
    HTMLDialogElement.prototype.showModal ??= function () {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function () {
      this.removeAttribute('open');
    };
  });

  afterEach(() => http.verify());

  it('is noindex and reuses the order view (lines, address, totals)', async () => {
    http = provideAccountTesting();
    signedIn(TestBed.inject(CustomerStore));
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(OrderDetailPage);
    fixture.componentRef.setInput('number', '100001');
    fixture.detectChanges();
    await tick();
    http.expectOne(URL).flush(orderView('paid'));
    await settle();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ noindex: true }));
    expect(el().querySelector('hg-order-detail')).not.toBeNull();
    expect(text()).toContain('ALBA');
    expect(text()).toContain('הרצל 12');
    expect(text()).toContain('3,450');
    expect(text()).toContain('שולמה');
  });

  it('does not list documents (they open only with the order token, which the account does not have)', async () => {
    await setup(orderView('paid', { invoices: [{ id: 'inv1', type: 'tax_invoice', number: '1001' } as never] }));
    expect(el().querySelector('.document-list')).toBeNull();
  });

  it('hides "retry payment" and says to use the link in the order e-mail', async () => {
    await setup(orderView('payment_failed', { canRetryPayment: true }));
    expect(button('נסו לשלם שוב')).toBeUndefined();
    expect(text()).toContain('להשלמת התשלום אפשר להשתמש בקישור שנשלח במייל ההזמנה');
  });

  it('does not show that line when payment cannot be retried', async () => {
    await setup(orderView('paid'));
    expect(text()).not.toContain('להשלמת התשלום');
  });

  it('cancels an unpaid order with the account endpoint after a confirmation', async () => {
    await setup(orderView('pending_payment'));
    button('ביטול ההזמנה')!.click();
    fixture.detectChanges();
    button('כן, לבטל')!.click();
    const req = http.expectOne('/api/account/orders/100001/cancel');
    expect(req.request.method).toBe('POST');
    req.flush(orderView('cancelled'));
    await settle();
    expect(text()).toContain('ההזמנה בוטלה');
    expect(button('ביטול ההזמנה')).toBeUndefined();
  });

  it('a 409 on cancel says it is no longer possible and shows the real state', async () => {
    await setup(orderView('pending_payment'));
    button('ביטול ההזמנה')!.click();
    fixture.detectChanges();
    button('כן, לבטל')!.click();
    failWith(http.expectOne('/api/account/orders/100001/cancel'), 409, 'invalid_transition');
    await tick();
    http.expectOne(URL).flush(orderView('paid'));
    await settle();
    expect(text()).toContain('אי אפשר לבטל את ההזמנה כעת');
  });

  it('shows not found for another account order', async () => {
    await setup(404);
    expect(text()).toContain('ההזמנה לא נמצאה');
  });
});
