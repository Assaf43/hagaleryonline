import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import {
  ORDER_STATUS_LABELS_HE,
  type CustomerAddressView,
  type CustomerMe,
  type OrderStatus,
  type OrderView,
} from '@hg/models';

/** Fixtures and helpers for the account specs (not used by the app). */
export function customerMe(over: Partial<CustomerMe> = {}): CustomerMe {
  return {
    id: 'c1',
    fullName: 'דנה כהן',
    phone: '0501234567',
    email: 'dana@example.com',
    phoneVerified: true,
    emailVerified: true,
    hasPassword: true,
    marketingConsent: false,
    marketingConsentAt: null,
    ...over,
  };
}

/** HTTP testing with an empty router; returns the controller. */
export function provideAccountTesting(extra: unknown[] = []): HttpTestingController {
  TestBed.configureTestingModule({
    providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([]), ...(extra as never[])],
  });
  return TestBed.inject(HttpTestingController);
}

/** Answers a request with an API error body (`{ statusCode, code, ...extra }`). */
export function failWith(req: TestRequest, status: number, code: string, extra: Record<string, unknown> = {}) {
  req.flush({ statusCode: status, code, ...extra }, { status, statusText: 'Error' });
}

/** Answers every pending cart read (a sign-in or sign-out reloads the cart). */
export function flushCarts(http: HttpTestingController) {
  for (const req of http.match('/api/cart')) {
    req.flush({
      lines: [],
      itemCount: 0,
      subtotal: 0,
      deliveryEstimate: null,
      notices: [],
      shippingFrom: null,
      discount: null,
      couponCode: null,
    });
  }
}

/** A paste event on an element with the given clipboard text. */
export function pasteInto(el: HTMLElement, text: string) {
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { getData: () => text } });
  el.dispatchEvent(event);
}

export function typeInto(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

export function addressView(over: Partial<CustomerAddressView> = {}): CustomerAddressView {
  return {
    id: 'a1',
    localityId: 5000,
    localityNameHe: 'תל אביב - יפו',
    street: 'הרצל',
    houseNumber: '12',
    apartment: '5',
    floor: 3,
    hasElevator: true,
    notes: null,
    isDefault: true,
    ...over,
  };
}

export function orderView(status: OrderStatus = 'paid', extra: Partial<OrderView> = {}): OrderView {
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
    shippingLines: [],
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
    invoices: [],
    ...extra,
  };
}

/** Signs a customer in the store without any request (data pages then load their own data). */
export function signedIn(store: { restore(c: CustomerMe | null): void }, me: CustomerMe = customerMe()) {
  store.restore(me);
}

/** Lets every pending promise continuation run (the pages await their API calls). */
export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
