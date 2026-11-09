import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideChevronDown } from '@lucide/angular';
import type { ProductDetail, VariantDetail } from '@hg/models';
import { dimensionRows } from './dimension-rows';
import { SHIPPING_INFO } from './shipping-info';

/** Warranty in natural Hebrew ("שנה", "חודשיים"…); null or 0 means no warranty row. */
export function warrantyText(months: number | null): string | null {
  if (!months) return null;
  const words: Record<number, string> = { 1: 'חודש אחד', 2: 'חודשיים', 12: 'שנה', 24: 'שנתיים' };
  return words[months] ?? `${months} חודשים`;
}

/** The product page accordion (PRD-06, PRD-08, PRD-10): description, dimensions, specs, shipping and returns. */
@Component({
  selector: 'hg-product-details',
  imports: [LucideChevronDown, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './product-details.html',
  styleUrl: './product-details.scss',
})
export class ProductDetails {
  readonly product = input.required<ProductDetail>();
  readonly variant = input.required<VariantDetail>();

  protected readonly shipping = SHIPPING_INFO.paragraphsHe;
  protected readonly dimensions = computed(() => dimensionRows(this.variant().dimensions));
  protected readonly specRows = computed(() => {
    const p = this.product();
    const rows: { labelHe: string; value: string }[] = [];
    for (const s of p.specs) if (s.valuesHe.length) rows.push({ labelHe: s.nameHe, value: s.valuesHe.join(', ') });
    if (p.countryOfOrigin) rows.push({ labelHe: 'ארץ ייצור', value: p.countryOfOrigin });
    const warranty = warrantyText(p.warrantyMonths);
    if (warranty) rows.push({ labelHe: 'אחריות', value: warranty });
    if (p.careHe) rows.push({ labelHe: 'הוראות תחזוקה', value: p.careHe });
    rows.push({ labelHe: 'הרכבה', value: p.requiresAssembly ? 'נדרשת הרכבה' : 'מגיע מורכב' });
    return rows;
  });
}
