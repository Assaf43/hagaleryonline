import type { InvoiceLine } from './invoice-provider.js';

/** The parts of an order (its snapshot taken at checkout) a tax invoice is built from. */
export interface InvoiceOrderSource {
  number: number;
  total: number;
  discount: number;
  /** `orders.discount_info`: `{ labelHe, … }` or null. */
  discountInfo: unknown;
  /** `orders.shipping_lines`: `[{ labelHe, amount }]`. */
  shippingLines: unknown;
  items: {
    modelName: string;
    nameHe: string;
    optionLabels: unknown;
    unitPrice: number;
    quantity: number;
    lineTotal: number;
  }[];
}

/**
 * The lines of an order's tax invoice / receipt (spec §5.4): every item ("MODEL nameHe options"), every shipping line,
 * and a negative discount line when the order has a discount. They must add up to the order total; otherwise this
 * throws, because a tax document that disagrees with what was charged must never be issued.
 */
export function orderInvoiceLines(order: InvoiceOrderSource): InvoiceLine[] {
  const lines: InvoiceLine[] = order.items.map((i) => {
    if (i.unitPrice * i.quantity !== i.lineTotal)
      throw new Error(
        `Order ${order.number}: line ${i.modelName} total ${i.lineTotal} is not unit price × quantity (${i.unitPrice} × ${i.quantity})`,
      );
    const options = Array.isArray(i.optionLabels) ? (i.optionLabels as unknown[]).map(String).join(', ') : '';
    return {
      description: [i.modelName, i.nameHe, options].filter((part) => part.trim() !== '').join(' '),
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: i.lineTotal,
    };
  });
  if (!Array.isArray(order.shippingLines)) throw new Error(`Order ${order.number}: malformed shipping lines`);
  for (const raw of order.shippingLines as unknown[]) {
    const { labelHe, amount } = (raw ?? {}) as { labelHe?: unknown; amount?: unknown };
    if (typeof labelHe !== 'string' || !Number.isInteger(amount))
      throw new Error(`Order ${order.number}: malformed shipping lines`);
    if (amount === 0) continue;
    lines.push({ description: labelHe, quantity: 1, unitPrice: amount as number, lineTotal: amount as number });
  }
  if (order.discount > 0) {
    const info = order.discountInfo as { labelHe?: unknown } | null;
    const label = typeof info?.labelHe === 'string' && info.labelHe.trim() ? info.labelHe : 'הנחה';
    lines.push({ description: label, quantity: 1, unitPrice: -order.discount, lineTotal: -order.discount });
  }
  const sum = lines.reduce((total, l) => total + l.lineTotal, 0);
  if (sum !== order.total)
    throw new Error(`Order ${order.number}: invoice lines (${sum}) do not add up to the order total (${order.total})`);
  return lines;
}

/** The one line of a credit note: "זיכוי להזמנה {number}" for the refunded amount. */
export function creditNoteLines(orderNumber: number, amount: number): InvoiceLine[] {
  return [{ description: `זיכוי להזמנה ${orderNumber}`, quantity: 1, unitPrice: amount, lineTotal: amount }];
}
