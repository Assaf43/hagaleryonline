import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideChevronDown, LucideInfo, LucideRuler } from '@lucide/angular';
import type { Facet, FulfillmentMode, ProductListResponse } from '@hg/models';
import { DELIVERY_FILTER_LABELS, productCount } from '../core/format';
import { setRange, toggleDelivery, toggleValue, type ListingState, type Range, type RangeKey } from './listing-state';

interface RangeField {
  key: RangeKey;
  label: string;
  /** Bounds of the current results, for the placeholders. */
  bounds: { min: number; max: number } | null;
}

/**
 * Filters of a product listing (CAT-04, CAT-05): size and price ranges, the category's attributes
 * and delivery time. Every change applies at once; counts come from the API and already take the
 * other filters into account. Values with no matching products are hidden unless selected.
 */
@Component({
  selector: 'hg-filters-panel',
  imports: [LucideChevronDown, LucideInfo, LucideRuler],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './filters-panel.html',
  styleUrl: './filters-panel.scss',
})
export class FiltersPanel {
  readonly state = input.required<ListingState>();
  readonly response = input.required<ProductListResponse | null>();
  readonly changed = output<ListingState>();

  protected readonly rangeFields = computed<RangeField[]>(() => {
    const r = this.response()?.ranges;
    const shekels = (b: { min: number; max: number } | null | undefined) =>
      b ? { min: Math.floor(b.min / 100), max: Math.ceil(b.max / 100) } : null;
    return [
      { key: 'width', label: 'רוחב (ס״מ)', bounds: r?.width ?? null },
      { key: 'depth', label: 'עומק (ס״מ)', bounds: r?.depth ?? null },
      { key: 'price', label: 'מחיר (₪)', bounds: shekels(r?.price) },
    ];
  });

  protected readonly facets = computed<Facet[]>(() =>
    (this.response()?.facets ?? [])
      .map((f) => ({ ...f, values: f.values.filter((v) => v.count > 0 || v.selected) }))
      .filter((f) => f.values.length > 0),
  );

  protected readonly delivery = computed(() =>
    (this.response()?.fulfillment ?? [])
      .filter((d) => d.count > 0 || d.selected)
      .map((d) => ({ ...d, label: DELIVERY_FILTER_LABELS[d.mode] })),
  );

  protected readonly count = productCount;

  protected rangeChanged(key: RangeKey, which: keyof Range, input: HTMLInputElement) {
    const raw = input.value.trim().replace(/[,₪\s]/g, '');
    const value = raw === '' ? null : Number(raw);
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      input.value = String(this.state().ranges[key][which] ?? '');
      return;
    }
    const range = { ...this.state().ranges[key], [which]: value === null ? null : Math.round(value) };
    this.changed.emit(setRange(this.state(), key, range));
  }

  protected toggle(code: string, value: string) {
    this.changed.emit(toggleValue(this.state(), code, value));
  }

  protected toggleDelivery(mode: FulfillmentMode) {
    this.changed.emit(toggleDelivery(this.state(), mode));
  }
}
