import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LucideChevronDown } from '@lucide/angular';
import type { ProductDetail, VariantDetail } from '@hg/models';
import { dimensionRows } from './dimension-rows';
import { SHIPPING_INFO } from './shipping-info';

/** The product page accordion (PRD-06, PRD-08, PRD-10): description, dimensions, specs, shipping and returns. */
@Component({
  selector: 'hg-product-details',
  imports: [LucideChevronDown],
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
    if (p.warrantyMonths != null) rows.push({ labelHe: 'אחריות', value: `${p.warrantyMonths} חודשים` });
    if (p.careHe) rows.push({ labelHe: 'הוראות תחזוקה', value: p.careHe });
    rows.push({ labelHe: 'הרכבה', value: p.requiresAssembly ? 'נדרשת הרכבה' : 'מגיע מורכב' });
    return rows;
  });
}
