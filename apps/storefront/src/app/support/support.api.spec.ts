import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { HttpTestingController } from '@angular/common/http/testing';
import { SUPPORT_RETURN_WINDOW_PASSED_HE } from '@hg/models';
import { SupportApi, supportErrorMessage, supportFailure, supportSuccessText } from './support.api';
import { deliveredOrder, failWith, setupSupport, tick } from './support.testing';

const failure = (status: number, body: object) =>
  supportFailure(new HttpErrorResponse({ status, error: { statusCode: status, ...body } }));

describe('support error mapping', () => {
  it('returns: return_window_passed and not_delivered use the agreed wording', () => {
    expect(supportErrorMessage(failure(409, { code: 'return_window_passed' }), 'return')).toBe(
      'עבר מועד ההחזרה להזמנה הזו',
    );
    expect(SUPPORT_RETURN_WINDOW_PASSED_HE).toBe('עבר מועד ההחזרה להזמנה הזו');
    expect(supportErrorMessage(failure(409, { code: 'not_delivered' }), 'return')).toBe(
      'אפשר לבקש החזרה רק אחרי שההזמנה סופקה',
    );
  });

  it('damaged: not_delivered uses the shared wording', () => {
    expect(supportErrorMessage(failure(409, { code: 'not_delivered' }), 'damaged')).toBe(
      'אפשר לשלוח בקשה זו רק להזמנה שסופקה',
    );
  });

  it('invalid_field prefers the server message, else the shared message of the field', () => {
    expect(supportErrorMessage(failure(400, { code: 'invalid_field', field: 'note', messageHe: 'X' }), 'return')).toBe(
      'X',
    );
    expect(supportErrorMessage(failure(400, { code: 'invalid_field', field: 'items.2.quantity' }), 'return')).toBe(
      'יש לבחור פריטים וכמויות מתוך ההזמנה',
    );
  });

  it('404, 429 and unknown errors', () => {
    expect(supportErrorMessage(failure(404, { code: 'not_found' }), 'return')).toBe('לא מצאנו הזמנה עם הפרטים האלה');
    expect(supportErrorMessage(failure(429, {}), 'contact')).toContain('יותר מדי ניסיונות');
    expect(supportErrorMessage(supportFailure(new Error('x')), 'contact')).toBe('משהו השתבש. נסו שוב.');
  });

  it('the confirmation text carries the ticket number', () => {
    expect(supportSuccessText(5001)).toBe('קיבלנו את פנייתך. מספר הפנייה: 5001');
  });
});

describe('SupportApi.loadOrder', () => {
  let http: HttpTestingController;
  let api: SupportApi;

  it('signed out: lookup, then the order with the link token as a query parameter; the reference is number + phone', async () => {
    http = setupSupport();
    api = TestBed.inject(SupportApi);
    const result = api.loadOrder('100001', '0501234567');
    await tick();
    http.expectOne('/api/orders/lookup').flush({ url: '/order/100001?t=abc' });
    await tick();
    const read = http.expectOne((r) => r.url === '/api/orders/100001');
    expect(read.request.params.get('t')).toBe('abc');
    read.flush(deliveredOrder());
    const { order, ref } = await result;
    expect(order.number).toBe(100001);
    expect(ref).toEqual({ number: '100001', phone: '0501234567' });
    http.verify();
  });

  it('signed in: the account order, no reference', async () => {
    http = setupSupport(true);
    api = TestBed.inject(SupportApi);
    const result = api.loadOrder('100001', null);
    http.expectOne('/api/account/orders/100001').flush(deliveredOrder());
    expect((await result).ref).toBeNull();
    http.verify();
  });

  it('a miss rejects with the 404', async () => {
    http = setupSupport();
    api = TestBed.inject(SupportApi);
    const result = api.loadOrder('1', '0501234567');
    await tick();
    failWith(http.expectOne('/api/orders/lookup'), 404, 'not_found');
    await expect(result).rejects.toBeInstanceOf(HttpErrorResponse);
    http.verify();
  });
});
