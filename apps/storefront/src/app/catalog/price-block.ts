import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import type { VariantDetail } from '@hg/models';
import { formatPrice } from '../core/format';
import { MEMBER_PRICE_LABEL_HE, REGULAR_PRICE_SR_HE, Viewer, memberPriceView } from './member-price';

/** Price of the chosen variant (PRD-02): sale price in red, old price struck through, "-N%" badge. VAT included. */
@Component({
  selector: 'hg-price-block',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let pv = view();
    <p class="row">
      <span class="price-now num" [class.sale]="onSale() && pv.memberLine?.kind !== 'member'">{{
        money(pv.main)
      }}</span>
      @if (pv.struck) {
        <s class="old num"
          ><span class="visually-hidden">{{ pv.memberLine?.kind === 'member' ? regularSr : 'במקום ' }}</span
          >{{ money(pv.struck) }}</s
        >
      }
      @if (onSale()) {
        <span class="badge badge-sale"
          ><bdi dir="ltr" class="num">-{{ discount() }}%</bdi></span
        >
      }
    </p>
    @if (pv.memberLine?.kind === 'member') {
      <p class="member-label">{{ memberLabel }}</p>
    }
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

    .member-label {
      margin: var(--space-1) 0 0;
      font-size: var(--font-small);
      font-weight: 600;
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
  private readonly viewer = inject(Viewer);
  protected readonly money = formatPrice;
  protected readonly memberLabel = MEMBER_PRICE_LABEL_HE;
  protected readonly regularSr = REGULAR_PRICE_SR_HE;
  /** The viewer is known only in the browser, so the server render shows the regular price (CLB-03). */
  protected readonly view = computed(() => {
    const v = this.variant();
    return memberPriceView(v.price, v.compareAtPrice, v.memberPrice, this.viewer.isMember());
  });
  protected readonly discount = computed(() => {
    const v = this.variant();
    return v.compareAtPrice ? Math.round((1 - v.price / v.compareAtPrice) * 100) : 0;
  });
}
