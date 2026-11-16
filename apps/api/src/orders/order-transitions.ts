import { OrderStatus } from '../generated/prisma/client.js';

/** The only source of allowed order moves (spec §4.1): forward along the flow after payment, never backward. */
export const FLOW: readonly OrderStatus[] = [
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.DELIVERY_SCHEDULED,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

/**
 * An order that was paid, at any step of the flow after it. A payment webhook never changes such an order: a second
 * success is flagged `paid_twice`, and it counts as a live newer order for `superseded_paid`.
 */
export const PAID_OR_LATER: ReadonlySet<OrderStatus> = new Set(FLOW);

/** Statuses staff may cancel from (with `orders.cancel`); the customer only from `PENDING_PAYMENT`. */
const ADMIN_CANCELLABLE: readonly OrderStatus[] = [
  OrderStatus.PENDING_PAYMENT,
  OrderStatus.PAID,
  OrderStatus.PROCESSING,
  OrderStatus.DELIVERY_SCHEDULED,
  OrderStatus.SHIPPED,
];

/**
 * Statuses the seller may cancel their own store order from (Phase 6, recorded with the seller as an `ADMIN` actor):
 * the customer's rule plus a failed payment, so a sale the customer will not pay leaves the pending list. Never a paid
 * order — that is staff's cancel with its refund (`orders.cancel`).
 */
const SELLER_CANCELLABLE: readonly OrderStatus[] = [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_FAILED];

/** Forward along FLOW, skipping allowed. `DELIVERED` is final. */
export function canAdvance(from: OrderStatus, to: OrderStatus): boolean {
  const a = FLOW.indexOf(from);
  const b = FLOW.indexOf(to);
  return a >= 0 && b > a;
}

export function canCancel(from: OrderStatus, actor: 'admin' | 'customer' | 'seller'): boolean {
  if (actor === 'customer') return from === OrderStatus.PENDING_PAYMENT;
  return (actor === 'seller' ? SELLER_CANCELLABLE : ADMIN_CANCELLABLE).includes(from);
}

/** Statuses an order can be advanced to from `from`, in flow order. */
export function nextStatuses(from: OrderStatus): OrderStatus[] {
  return FLOW.filter((to) => canAdvance(from, to));
}
