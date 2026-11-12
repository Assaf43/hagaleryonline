/**
 * What can still be refunded on an order (agorot): the paid total minus the refunds that succeeded and those still
 * pending (a pending refund may yet succeed, so it already counts). Never negative.
 */
export function refundable(paidTotal: number, refundedTotal: number, pendingRefunds: number): number {
  return Math.max(0, paidTotal - refundedTotal - pendingRefunds);
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;

/** The trimmed reason when it is 3–500 characters, otherwise null (spec §4.3, decision 74). */
export function parseReason(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const reason = value.trim();
  return reason.length >= REASON_MIN && reason.length <= REASON_MAX ? reason : null;
}

/** A whole number of agorot, at least 1. */
export function parseAmount(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/**
 * The refund state of an order (agorot), from its rows. `paidTotal` is the sum of SUCCEEDED payments, capped at the
 * order total (the database keeps `refunded_total` within it). Pending refunds count against `refundable`; failed
 * ones do not.
 */
export function orderRefundState(order: {
  total: number;
  refundedTotal: number;
  payments: { status: string; amount: number }[];
  refunds: { status: string; amount: number }[];
}): { paidTotal: number; pendingRefunds: number; refundable: number } {
  const paid = order.payments.filter((p) => p.status === 'SUCCEEDED').reduce((sum, p) => sum + p.amount, 0);
  const paidTotal = Math.min(paid, order.total);
  const pendingRefunds = order.refunds.filter((r) => r.status === 'PENDING').reduce((sum, r) => sum + r.amount, 0);
  return { paidTotal, pendingRefunds, refundable: refundable(paidTotal, order.refundedTotal, pendingRefunds) };
}
