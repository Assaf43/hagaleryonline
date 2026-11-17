import type { DiscountType } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';

/** "15%" or "200 ₪": a template's discount (percent 1–100, or agorot for a fixed one). */
export function discountText(type: DiscountType, value: number): string {
  return type === 'percent' ? `${value}%` : formatPrice(value);
}
