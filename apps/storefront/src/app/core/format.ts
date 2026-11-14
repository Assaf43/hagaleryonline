import { FULFILLMENT_LABELS_HE, type FulfillmentMode } from '@hg/models';

/** 459000 agorot → "4,590 ₪" — one formatter for the storefront and the API's messages (`@hg/models`). */
export { formatPrice } from '@hg/models';

const ILS = new Intl.NumberFormat('he-IL', { maximumFractionDigits: 0 });

/** Short delivery line for product cards (PRD-09): "במלאי · אספקה עד 14 ימי עסקים". */
export function deliveryText(mode: FulfillmentMode, days: number): string {
  const label = FULFILLMENT_LABELS_HE[mode];
  if (mode === 'out_of_stock') return label;
  return `${label} · אספקה עד ${days} ימי עסקים`;
}

/** The cart's one delivery line (CRT-04): "זמן אספקה משוער: עד 14 ימי עסקים". */
export function deliveryEstimateText(days: number): string {
  return `זמן אספקה משוער: עד ${days} ימי עסקים`;
}

/** Short delivery badge on a product photo: "אספקה עד 14 ימי עסקים". */
export function deliveryBadge(mode: FulfillmentMode, days: number): string {
  switch (mode) {
    case 'in_stock':
      return `אספקה עד ${days} ימי עסקים`;
    case 'pre_order':
      return 'מכירה מוקדמת';
    case 'made_to_order':
      return `בייצור · עד ${days} ימי עסקים`;
    case 'out_of_stock':
      return 'אזל מהמלאי';
  }
}

/** Labels of the delivery filter (CAT-04). */
export const DELIVERY_FILTER_LABELS: Record<FulfillmentMode, string> = {
  in_stock: 'במלאי',
  pre_order: 'מכירה מוקדמת',
  made_to_order: 'ייצור לפי הזמנה',
  out_of_stock: 'אזל מהמלאי',
};

/** "1 מוצר" reads wrong in Hebrew. */
export function productCount(n: number): string {
  return n === 1 ? 'מוצר אחד' : `${ILS.format(n)} מוצרים`;
}

const DATE = new Intl.DateTimeFormat('he-IL', {
  timeZone: 'Asia/Jerusalem',
  day: 'numeric',
  month: 'numeric',
  year: 'numeric',
});

/** An ISO time as the Israel calendar date: "10.11.2026". */
export function formatDate(iso: string): string {
  return DATE.format(new Date(iso));
}
