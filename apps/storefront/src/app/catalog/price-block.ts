import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import type { VariantDetail } from '@hg/models';
import { formatPrice } from '../core/format';

/** Price of the chosen variant (PRD-02): sale price in red, old price struck through, "-N%" badge. VAT included. */
@Component({
  selector: 'hg-price-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="row">
      <span class="price-now num" [class.sale]="onSale()">{{ price() }}</span>
      @if (onSale()) {
        <s class="old num"><span class="visually-hidden">במקום </span>{{ compareAt() }}</s>
        <span class="badge badge-sale"
          ><bdi dir="ltr" class="num">-{{ discount() }}%</bdi></span
        >
      }
    </p>
    <p class="vat">המחיר כולל מע״מ</p>
  `,
  styles: `
    :host {
      display: block;
    }

    .row {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-2) var(--space-3);
      margin: 0;
    }

    .price-now {
      font-size: var(--font-price);
      font-weight: 700;
    }

    .price-now.sale {
      color: var(--color-sale);
    }

    .old {
      color: var(--color-text-secondary);
    }

    .vat {
      margin: var(--space-1) 0 0;
      font-size: var(--font-caption);
      color: var(--color-text-secondary);
    }
  `,
})
export class PriceBlock {
  readonly variant = input.required<VariantDetail>();

  protected readonly onSale = computed(() => {
    const v = this.variant();
    return v.compareAtPrice !== null && v.compareAtPrice > v.price;
  });
  protected readonly price = computed(() => formatPrice(this.variant().price));
  protected readonly compareAt = computed(() => formatPrice(this.variant().compareAtPrice ?? 0));
  protected readonly discount = computed(() => {
    const v = this.variant();
    return v.compareAtPrice ? Math.round((1 - v.price / v.compareAtPrice) * 100) : 0;
  });
}
