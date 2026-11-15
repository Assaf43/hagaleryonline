import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { PageMeta } from '../core/page-meta';
import { ReturnPage } from './return.page';
import { answerLookup, deliveredOrder, failWith, setupSupport, tick } from './support.testing';

describe('ReturnPage (/returns, SRV-02)', () => {
  let fixture: ComponentFixture<ReturnPage>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent?.replace(/\s+/g, ' ') ?? '';
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => el().querySelector<T>(selector)!;
  const settle = async () => {
    await tick();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
  };
  const fill = (selector: string, value: string) => {
    const input = q(selector);
    input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    fixture.detectChanges();
  };
  const choose = (selector: string, value: string) => {
    const select = q<HTMLSelectElement>(selector);
    select.value = value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    fixture.detectChanges();
  };
  const click = async (selector: string) => {
    q<HTMLElement>(selector).click();
    await settle();
  };
  const submitStep = async () => {
    q<HTMLFormElement>('hg-support-order-step form').dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  };
  const submitForm = async () => {
    q<HTMLFormElement>('form:not(hg-support-order-step form)').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
  };
  const alerts = () => [...el().querySelectorAll('.form-error[role="alert"]')].map((a) => a.textContent?.trim());

  async function openOrder(order = deliveredOrder(), orderParam: string | undefined = '100001') {
    http = setupSupport();
    fixture = TestBed.createComponent(ReturnPage);
    document.body.appendChild(fixture.nativeElement);
    if (orderParam) fixture.componentRef.setInput('order', orderParam);
    fixture.detectChanges();
    await settle();
    fill('#rt-os-phone', '050-123-4567');
    await submitStep();
    await answerLookup(http, order);
    await settle();
  }

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
  });

  it('is a noindex page "החזרה או החלפה"', async () => {
    http = setupSupport();
    const set = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(ReturnPage);
    fixture.detectChanges();
    await settle();
    expect(set).toHaveBeenCalledWith(expect.objectContaining({ path: '/returns', noindex: true }));
    expect(q('h1').textContent?.trim()).toBe('החזרה או החלפה');
  });

  it('prefills the order number from the link and asks signed-out customers for the phone, with labels', async () => {
    http = setupSupport();
    fixture = TestBed.createComponent(ReturnPage);
    fixture.componentRef.setInput('order', '100001');
    fixture.detectChanges();
    await settle();
    expect(q('#rt-os-number').value).toBe('100001');
    expect(q('label[for="rt-os-number"]').textContent?.trim()).toBe('מספר הזמנה');
    expect(q('label[for="rt-os-phone"]').textContent?.trim()).toBe('טלפון נייד');
    http.expectNone('/api/orders/lookup');
  });

  it('looks the order up by number + phone and reads it with the link token as a query parameter only', async () => {
    http = setupSupport();
    const stored = vi.spyOn(Storage.prototype, 'setItem');
    fixture = TestBed.createComponent(ReturnPage);
    fixture.componentRef.setInput('order', '100001');
    fixture.detectChanges();
    await settle();
    fill('#rt-os-phone', '050-123-4567');
    await submitStep();
    await tick();
    const lookup = http.expectOne('/api/orders/lookup');
    expect(lookup.request.body).toEqual({ number: '100001', phone: '050-123-4567' });
    lookup.flush({ url: '/order/100001?t=tok123' });
    await tick();
    const read = http.expectOne((r) => r.url === '/api/orders/100001');
    expect(read.request.params.get('t')).toBe('tok123');
    read.flush(deliveredOrder());
    await settle();
    expect(text()).toContain('הזמנה מספר 100001');
    // The token stays in memory: not in storage, not on the page (links, text), not in the router's URL.
    expect(stored).not.toHaveBeenCalled();
    expect(el().innerHTML).not.toContain('tok123');
    expect(TestBed.inject(Router).url).not.toContain('tok123');
    stored.mockRestore();
  });

  it('a lookup miss shows one message and keeps the form', async () => {
    http = setupSupport();
    fixture = TestBed.createComponent(ReturnPage);
    fixture.detectChanges();
    await settle();
    fill('#rt-os-number', '100009');
    fill('#rt-os-phone', '0509999999');
    await submitStep();
    await tick();
    failWith(http.expectOne('/api/orders/lookup'), 404, 'not_found');
    await settle();
    expect(alerts()).toContain('לא מצאנו הזמנה עם הפרטים האלה');
    expect(q('#rt-os-number')).not.toBeNull();
  });

  it('asks for the number and the phone before looking anything up, focusing the first missing field', async () => {
    http = setupSupport();
    fixture = TestBed.createComponent(ReturnPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await settle();
    await submitStep();
    await settle();
    expect(text()).toContain('יש להזין את מספר ההזמנה');
    expect(q('#rt-os-number').getAttribute('aria-invalid')).toBe('true');
    expect(q('#rt-os-number').getAttribute('aria-describedby')).toBe('rt-os-number-error');
    expect(document.activeElement).toBe(q('#rt-os-number'));
    http.expectNone('/api/orders/lookup');
  });

  it('lists the lines (model name in ltr isolation), the deadline from returnUntil and the closed reason list', async () => {
    await openOrder(deliveredOrder({ returnUntil: '2026-12-01T10:00:00.000Z' }));
    expect(text()).toContain('אפשר לבקש החזרה או החלפה עד 1.12.2026');
    const names = [...el().querySelectorAll('.line bdi[dir="ltr"]')].map((b) => b.textContent);
    expect(names).toEqual(['ALBA', 'LUNA']);
    const reasons = [...el().querySelectorAll('#rt-reason option')].map((o) => o.textContent?.trim());
    expect(reasons).toEqual(['בחרו סיבה', 'התחרטתי', 'לא תואם לתיאור', 'התקבל פריט שגוי', 'המידה לא מתאימה', 'אחר']);
    expect(q('label[for="rt-reason"]').textContent?.trim()).toBe('סיבה');
    expect(q('label[for="rt-note"]').textContent).toContain('הערה');
  });

  it('refuses an empty submit with errors tied to the fields and focus on the first one', async () => {
    await openOrder();
    await submitForm();
    expect(text()).toContain('יש לבחור פריטים וכמויות מתוך ההזמנה');
    expect(text()).toContain('יש לבחור סיבה מהרשימה');
    expect(q('#rt-line-0').getAttribute('aria-invalid')).toBe('true');
    expect(q('fieldset[aria-describedby="rt-items-error"]')).not.toBeNull();
    expect(q('#rt-reason').getAttribute('aria-describedby')).toBe('rt-reason-error');
    expect(document.activeElement).toBe(q('#rt-line-0'));
    http.expectNone('/api/support/returns');
  });

  it('a line with several pieces offers a quantity up to the ordered one', async () => {
    await openOrder();
    await click('#rt-line-0');
    const options = [...el().querySelectorAll('#rt-qty-0 option')].map((o) => o.textContent?.trim());
    expect(options).toEqual(['1', '2']);
    await click('#rt-line-1');
    expect(el().querySelector('#rt-qty-1')).toBeNull();
  });

  it('sends the chosen lines, type, reason and note with the order reference, then confirms with the ticket number', async () => {
    await openOrder();
    await click('#rt-line-0');
    choose('#rt-qty-0', '1');
    await click('#rt-type-exchange');
    choose('#rt-reason', 'size');
    fill('#rt-note', '  קצת גדולה  ');
    await submitForm();
    const req = http.expectOne('/api/support/returns');
    expect(req.request.body).toEqual({
      order: { number: '100001', phone: '050-123-4567' },
      type: 'exchange',
      items: [{ orderItemId: 11, quantity: 1 }],
      reasonCode: 'size',
      note: 'קצת גדולה',
      website: '',
    });
    req.flush({ ticketNumber: 5001 }, { status: 202, statusText: 'Accepted' });
    await settle();
    const success = q<HTMLElement>('#rt-success');
    expect(success.textContent?.trim()).toBe('קיבלנו את פנייתך. מספר הפנייה: 5001');
    expect(success.getAttribute('role')).toBe('status');
    expect(document.activeElement).toBe(success);
    expect(el().querySelector('form')).toBeNull();
  });

  it('maps return_window_passed and not_delivered to the exact messages', async () => {
    await openOrder();
    await click('#rt-line-1');
    choose('#rt-reason', 'other');
    await submitForm();
    failWith(http.expectOne('/api/support/returns'), 409, 'return_window_passed', {
      messageHe: 'עבר מועד ההחזרה להזמנה הזו',
    });
    await settle();
    expect(alerts()).toContain('עבר מועד ההחזרה להזמנה הזו');
    await submitForm();
    failWith(http.expectOne('/api/support/returns'), 409, 'not_delivered', { messageHe: 'טקסט אחר מהשרת' });
    await settle();
    expect(alerts()).toContain('אפשר לבקש החזרה רק אחרי שההזמנה סופקה');
  });

  it('shows a server field error beside its field and focuses it', async () => {
    await openOrder();
    await click('#rt-line-1');
    choose('#rt-reason', 'other');
    await submitForm();
    failWith(http.expectOne('/api/support/returns'), 400, 'invalid_field', {
      field: 'items.0.quantity',
      messageHe: 'יש לבחור פריטים וכמויות מתוך ההזמנה',
    });
    await settle();
    expect(q('#rt-items-error').textContent).toContain('יש לבחור פריטים');
    expect(document.activeElement).toBe(q('#rt-line-0'));
  });

  it('a throttled request says to try again later', async () => {
    await openOrder();
    await click('#rt-line-1');
    choose('#rt-reason', 'other');
    await submitForm();
    failWith(http.expectOne('/api/support/returns'), 429, 'too_many_requests');
    await settle();
    expect(alerts().join(' ')).toContain('יותר מדי ניסיונות');
  });

  it('offers no form for an order that is not delivered', async () => {
    await openOrder(deliveredOrder({}, 'shipped'));
    expect(alerts()).toContain('אפשר לבקש החזרה רק אחרי שההזמנה סופקה');
    expect(el().querySelector('#rt-reason')).toBeNull();
  });

  it('offers no form once returnUntil has passed', async () => {
    await openOrder(deliveredOrder({ returnUntil: '2020-01-01T00:00:00.000Z' }));
    expect(alerts()).toContain('עבר מועד ההחזרה להזמנה הזו');
    expect(el().querySelector('#rt-reason')).toBeNull();
  });

  it('has a hidden honeypot named website that is out of the tab order and hidden from screen readers', async () => {
    await openOrder();
    const trap = q('#rt-website');
    expect(trap.getAttribute('name')).toBe('website');
    expect(trap.getAttribute('tabindex')).toBe('-1');
    expect(trap.closest('[aria-hidden="true"]')).not.toBeNull();
  });

  it('writes the "cannot use this order" reason into a region that was already rendered (announced)', async () => {
    http = setupSupport();
    fixture = TestBed.createComponent(ReturnPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    await settle();
    const region = q('#rt-blocked');
    expect(region.getAttribute('role')).toBe('alert');
    expect(region.textContent?.trim()).toBe('');
    fill('#rt-os-number', '100001');
    fill('#rt-os-phone', '050-123-4567');
    await submitStep();
    await answerLookup(http, deliveredOrder({}, 'shipped'));
    await settle();
    expect(q('#rt-blocked')).toBe(region);
    expect(region.textContent?.trim()).toBe('אפשר לבקש החזרה רק אחרי שההזמנה סופקה');
    expect(q('#rt-success').getAttribute('role')).toBe('status');
  });

  it('moves focus to the found order after the customer looks it up', async () => {
    await openOrder();
    expect(document.activeElement).toBe(q('#rt-os-summary'));
  });

  it('a signed-in customer needs no phone: the account order is read and the request carries no order reference', async () => {
    http = setupSupport(true);
    fixture = TestBed.createComponent(ReturnPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.componentRef.setInput('order', '100001');
    fixture.detectChanges();
    await settle();
    http.expectOne('/api/account/orders/100001').flush(deliveredOrder());
    await settle();
    expect(el().querySelector('#rt-os-phone')).toBeNull();
    http.expectNone('/api/orders/lookup');
    await click('#rt-line-1');
    choose('#rt-reason', 'changed_mind');
    await submitForm();
    const req = http.expectOne('/api/support/returns');
    expect(req.request.body.order).toBeNull();
    req.flush({ ticketNumber: 5002 }, { status: 202, statusText: 'Accepted' });
    await settle();
    expect(text()).toContain('מספר הפנייה: 5002');
  });
});
