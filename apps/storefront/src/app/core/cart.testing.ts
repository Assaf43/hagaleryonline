import type { CartLine, CartView } from '@hg/models';

/** Cart fixtures for specs (not used by the app). */
export function cartLine(variantId: number, quantity: number, unitPrice = 100000): CartLine {
  return {
    variantId,
    productSlug: `p${variantId}`,
    modelName: `MODEL${variantId}`,
    nameHe: `מוצר ${variantId}`,
    optionLabels: ['בז׳', '280 ס״מ'],
    image: { url: `/media/${variantId}.webp`, altHe: `תמונה ${variantId}` },
    unitPrice,
    compareAtPrice: null,
    quantity,
    lineTotal: unitPrice * quantity,
    maxQuantity: 10,
    fulfillment: 'in_stock',
    leadTimeDays: 14,
    available: true,
  };
}

export function cartView(lines: CartLine[] = [], notices: CartView['notices'] = []): CartView {
  return {
    lines,
    itemCount: lines.reduce((n, l) => n + l.quantity, 0),
    subtotal: lines.reduce((n, l) => n + l.lineTotal, 0),
    deliveryEstimate: lines.length ? { fulfillment: 'in_stock', leadTimeDays: 14 } : null,
    notices,
    shippingFrom: null,
    discount: null,
  };
}
