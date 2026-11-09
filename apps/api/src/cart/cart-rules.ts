import type { FulfillmentMode } from '@hg/models';
import { MAX_MADE_TO_ORDER } from './available-stock.js';

/** Most units one cart line may hold (CRT-02): stock in stock, 10 made to order / pre-order, none out of stock. */
export function lineLimit(fulfillment: FulfillmentMode, available: number): number {
  switch (fulfillment) {
    case 'in_stock':
      return Math.max(0, available);
    case 'pre_order':
    case 'made_to_order':
      return MAX_MADE_TO_ORDER;
    case 'out_of_stock':
      return 0;
  }
}

/** At least 1 and at most the limit; 0 only when the limit is 0. */
export function clampQuantity(requested: number, limit: number): number {
  if (limit < 1) return 0;
  return Math.min(Math.max(requested, 1), limit);
}

/** Slower modes rank higher; a lead-time tie goes to the slower one. */
const SLOWNESS: Record<FulfillmentMode, number> = { in_stock: 0, pre_order: 1, made_to_order: 2, out_of_stock: 3 };

/** The slowest available line (CRT-04): the longest lead time and its fulfillment mode. */
export function deliveryEstimate(
  lines: { fulfillment: FulfillmentMode; leadTimeDays: number; available: boolean }[],
): { fulfillment: FulfillmentMode; leadTimeDays: number } | null {
  let slowest: { fulfillment: FulfillmentMode; leadTimeDays: number } | null = null;
  for (const { fulfillment, leadTimeDays, available } of lines) {
    if (!available) continue;
    if (
      !slowest ||
      leadTimeDays > slowest.leadTimeDays ||
      (leadTimeDays === slowest.leadTimeDays && SLOWNESS[fulfillment] > SLOWNESS[slowest.fulfillment])
    )
      slowest = { fulfillment, leadTimeDays };
  }
  return slowest;
}
