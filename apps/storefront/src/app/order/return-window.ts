import type { OrderView } from '@hg/models';

/**
 * A return or exchange can still be requested: the API's `returnUntil` (end of the Israel day of the last allowed
 * date) has not passed. Without a deadline (not delivered) the order's status decides elsewhere.
 */
export function returnOpen(order: Pick<OrderView, 'returnUntil'>, now = Date.now()): boolean {
  return !order.returnUntil || now <= Date.parse(order.returnUntil);
}
