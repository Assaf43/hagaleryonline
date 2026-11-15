import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import type { OrderStatus, OrderView } from '@hg/models';
import { customerMe, failWith, orderView, tick } from '../account/account.testing';
import { CustomerStore } from '../account/customer.store';

export { failWith, tick };

/** A delivered order (two lines, one with 2 pieces) whose return window ends far in the future. */
export function deliveredOrder(extra: Partial<OrderView> = {}, status: OrderStatus = 'delivered'): OrderView {
  const base = orderView(status);
  const delivered = status === 'delivered';
  return {
    ...base,
    deliveredAt: delivered ? '2026-11-10T10:00:00.000Z' : null,
    returnUntil: delivered ? '2999-01-01T10:00:00.000Z' : null,
    lines: [
      { ...base.lines[0], orderItemId: 11, quantity: 2, lineTotal: 600000 },
      { ...base.lines[0], orderItemId: 12, sku: 'TBL-1', modelName: 'LUNA', nameHe: 'שולחן קפה', quantity: 1 },
    ],
    ...extra,
  };
}

/** HTTP testing + router; the customer store is "ready" (signed out, or signed in as `customerMe()`). */
export function setupSupport(signedInAs: boolean = false): HttpTestingController {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
  TestBed.inject(CustomerStore).restore(signedInAs ? customerMe() : null);
  return TestBed.inject(HttpTestingController);
}

/**
 * Answers the order lookup of a signed-out customer, then the order read made with the link's token; returns the
 * order read request (to check the token travels as a query parameter).
 */
export async function answerLookup(http: HttpTestingController, order: OrderView): Promise<TestRequest> {
  await tick();
  http.expectOne('/api/orders/lookup').flush({ url: `/order/${order.number}?t=tok123` });
  await tick();
  const read = http.expectOne((r) => r.url === `/api/orders/${order.number}`);
  read.flush(order);
  return read;
}
