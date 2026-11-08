import { PRODUCT_SORTS, type Facet, type FulfillmentMode, type ProductSort } from '@hg/models';
import { DELIVERY_FILTER_LABELS } from '../core/format';

/**
 * Filter, sort and page state of a product listing, kept in the page URL (CAT-08) so a filtered
 * view can be shared, bookmarked and reloaded. Storefront URLs use shekels and short names:
 *   /category/sofas?color=beige,gray&minWidth=220&maxPrice=6000&delivery=in_stock&sort=price_asc&page=2
 * The API gets the same state as agorot and `attr.<code>` (see `toApiParams`).
 */

export type RangeKey = 'price' | 'width' | 'depth';
export interface Range {
  min: number | null;
  max: number | null;
}

export interface ListingState {
  sort: ProductSort;
  /** How many pages are shown ("load more" adds one). */
  page: number;
  ranges: Record<RangeKey, Range>;
  delivery: FulfillmentMode[];
  /** Attribute code → selected value codes, e.g. { color: ['beige'] }. */
  attributes: Record<string, string[]>;
}

export const PAGE_SIZE = 24;
/** Opening a deep "load more" link loads at most this many pages. */
export const MAX_PAGES = 10;

const RANGE_PARAMS: Record<RangeKey, [string, string]> = {
  price: ['minPrice', 'maxPrice'],
  width: ['minWidth', 'maxWidth'],
  depth: ['minDepth', 'maxDepth'],
};
const DELIVERY: FulfillmentMode[] = ['in_stock', 'pre_order', 'made_to_order', 'out_of_stock'];
const RESERVED = new Set(['sort', 'page', 'q', 'delivery', ...Object.values(RANGE_PARAMS).flat()]);
const CODE = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export const SORT_LABELS: Record<ProductSort, string> = {
  recommended: 'מומלץ',
  bestsellers: 'הנמכרים ביותר',
  price_asc: 'מחיר: מהנמוך לגבוה',
  price_desc: 'מחיר: מהגבוה לנמוך',
  newest: 'חדש באתר',
};

export function emptyState(): ListingState {
  return {
    sort: 'recommended',
    page: 1,
    ranges: { price: none(), width: none(), depth: none() },
    delivery: [],
    attributes: {},
  };
}

/** Reads the URL query. Anything malformed is ignored rather than failing the page. */
export function parseListing(query: Record<string, string | string[] | undefined>): ListingState {
  const state = emptyState();
  const one = (key: string) => {
    const v = query[key];
    return Array.isArray(v) ? v[0] : v;
  };
  const list = (key: string) =>
    (one(key) ?? '')
      .split(',')
      .map((v) => v.trim())
      .filter((v) => CODE.test(v));

  const sort = one('sort');
  if (PRODUCT_SORTS.includes(sort as ProductSort)) state.sort = sort as ProductSort;
  const page = Number(one('page'));
  if (Number.isInteger(page) && page > 1) state.page = Math.min(page, MAX_PAGES);

  for (const [key, [minKey, maxKey]] of Object.entries(RANGE_PARAMS) as [RangeKey, [string, string]][]) {
    state.ranges[key] = { min: amount(one(minKey)), max: amount(one(maxKey)) };
  }
  state.delivery = list('delivery').filter((d): d is FulfillmentMode => DELIVERY.includes(d as FulfillmentMode));
  for (const key of Object.keys(query)) {
    if (RESERVED.has(key) || !CODE.test(key)) continue;
    const values = list(key);
    if (values.length) state.attributes[key] = values;
  }
  return state;
}

/** The URL query for a state; defaults are left out so URLs stay short. */
export function toUrlParams(state: ListingState): Record<string, string> {
  const params: Record<string, string> = {};
  for (const [code, values] of Object.entries(state.attributes)) if (values.length) params[code] = values.join(',');
  for (const [key, [minKey, maxKey]] of Object.entries(RANGE_PARAMS) as [RangeKey, [string, string]][]) {
    const { min, max } = state.ranges[key];
    if (min !== null) params[minKey] = String(min);
    if (max !== null) params[maxKey] = String(max);
  }
  if (state.delivery.length) params['delivery'] = state.delivery.join(',');
  if (state.sort !== 'recommended') params['sort'] = state.sort;
  if (state.page > 1) params['page'] = String(state.page);
  return params;
}

/** Query of GET /api/products for one page. Prices go to the API in agorot. */
export function toApiParams(
  state: ListingState,
  scope: { category?: string; room?: string; q?: string },
  page: number,
): Record<string, string> {
  const params: Record<string, string> = { pageSize: String(PAGE_SIZE), page: String(page) };
  if (scope.category) params['category'] = scope.category;
  if (scope.room) params['room'] = scope.room;
  if (scope.q) params['q'] = scope.q;
  for (const [code, values] of Object.entries(state.attributes)) params[`attr.${code}`] = values.join(',');
  for (const [key, [minKey, maxKey]] of Object.entries(RANGE_PARAMS) as [RangeKey, [string, string]][]) {
    const factor = key === 'price' ? 100 : 1;
    const { min, max } = state.ranges[key];
    if (min !== null) params[minKey] = String(min * factor);
    if (max !== null) params[maxKey] = String(max * factor);
  }
  if (state.delivery.length) params['fulfillment'] = state.delivery.join(',');
  if (state.sort !== 'recommended') params['sort'] = state.sort;
  return params;
}

// ---------- Changes (each returns a new state, back on page 1) ----------

export function toggleValue(state: ListingState, code: string, value: string): ListingState {
  const current = state.attributes[code] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  const attributes = { ...state.attributes, [code]: next };
  if (!next.length) delete attributes[code];
  return { ...state, attributes, page: 1 };
}

export function toggleDelivery(state: ListingState, mode: FulfillmentMode): ListingState {
  const delivery = state.delivery.includes(mode) ? state.delivery.filter((d) => d !== mode) : [...state.delivery, mode];
  return { ...state, delivery, page: 1 };
}

export function setRange(state: ListingState, key: RangeKey, range: Range): ListingState {
  let { min, max } = range;
  if (min !== null && max !== null && min > max) [min, max] = [max, min];
  return { ...state, ranges: { ...state.ranges, [key]: { min, max } }, page: 1 };
}

export function setSort(state: ListingState, sort: ProductSort): ListingState {
  return { ...state, sort, page: 1 };
}

/** Clears every filter but keeps the chosen sort. */
export function clearFilters(state: ListingState): ListingState {
  return { ...emptyState(), sort: state.sort };
}

export function filterCount(state: ListingState): number {
  const ranges = Object.values(state.ranges).filter((r) => r.min !== null || r.max !== null).length;
  return ranges + state.delivery.length + Object.values(state.attributes).reduce((n, v) => n + v.length, 0);
}

// ---------- Active-filter chips (CAT-06) ----------

export interface FilterChip {
  key: string;
  label: string;
  /** The state without this filter. */
  without: ListingState;
}

const RANGE_LABELS: Record<RangeKey, [string, string]> = {
  price: ['מחיר', '₪'],
  width: ['רוחב', 'ס״מ'],
  depth: ['עומק', 'ס״מ'],
};

export function activeChips(state: ListingState, facets: Facet[]): FilterChip[] {
  const chips: FilterChip[] = [];
  for (const [key, range] of Object.entries(state.ranges) as [RangeKey, Range][]) {
    if (range.min === null && range.max === null) continue;
    const [name, unit] = RANGE_LABELS[key];
    const text =
      range.min !== null && range.max !== null
        ? `${range.min}–${range.max}`
        : range.min !== null
          ? `מ-${range.min}`
          : `עד ${range.max}`;
    chips.push({ key, label: `${name} ${text} ${unit}`, without: setRange(state, key, { min: null, max: null }) });
  }
  for (const [code, values] of Object.entries(state.attributes)) {
    const facet = facets.find((f) => f.code === code);
    for (const value of values) {
      const label = facet?.values.find((v) => v.code === value)?.labelHe ?? value;
      chips.push({ key: `${code}:${value}`, label, without: toggleValue(state, code, value) });
    }
  }
  for (const mode of state.delivery)
    chips.push({ key: `delivery:${mode}`, label: DELIVERY_FILTER_LABELS[mode], without: toggleDelivery(state, mode) });
  return chips;
}

function none(): Range {
  return { min: null, max: null };
}

function amount(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
