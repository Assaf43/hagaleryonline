import { HttpErrorResponse } from '@angular/common/http';
import type { StoreCartView } from '@hg/models';
import { canEnter, isCompleteCode, sanitizeCode, stepAfterError, type SaleState } from './steps';

const line = { variantId: 1, available: true } as StoreCartView['lines'][number];
const cart = (customer: StoreCartView['customer'] = null): StoreCartView =>
  ({ lines: [line], customer }) as unknown as StoreCartView;
const customer = { id: 'c', fullName: 'דנה', phone: '0501234567', email: null, emailVerified: false, isNew: false };
const state = (over: Partial<SaleState>): SaleState => ({ cart: null, delivery: null, orderNumber: null, ...over });

describe('store sale step machine', () => {
  it('needs lines before the customer step and a confirmed customer before delivery', () => {
    expect(canEnter('customer', state({ cart: null }))).toBe(false);
    expect(canEnter('customer', state({ cart: cart() }))).toBe(true);
    expect(canEnter('delivery', state({ cart: cart() }))).toBe(false);
    expect(canEnter('delivery', state({ cart: cart(customer) }))).toBe(true);
  });

  it('needs a delivery choice before the summary and an order before the status', () => {
    expect(canEnter('summary', state({ cart: cart(customer) }))).toBe(false);
    const delivery = {} as never;
    expect(canEnter('summary', state({ cart: cart(customer), delivery }))).toBe(true);
    expect(canEnter('status', state({ cart: cart(customer), delivery }))).toBe(false);
    expect(canEnter('status', state({ orderNumber: 100001 }))).toBe(true);
  });

  it('sends customer_not_confirmed back to the customer step', () => {
    const err = new HttpErrorResponse({ status: 409, error: { code: 'customer_not_confirmed' } });
    expect(stepAfterError(err)).toBe('customer');
    expect(stepAfterError(new HttpErrorResponse({ status: 409, error: { code: 'order_pending' } }))).toBeNull();
  });

  it('takes a code of six digits only', () => {
    expect(sanitizeCode('12a 34-5678')).toBe('123456');
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });
});
