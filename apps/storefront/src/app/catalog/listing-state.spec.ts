import type { Facet } from '@hg/models';
import { deliveryBadge, deliveryText, formatPrice, productCount } from '../core/format';
import {
  activeChips,
  clearFilters,
  filterCount,
  parseListing,
  setRange,
  setSort,
  toApiParams,
  toUrlParams,
  toggleDelivery,
  toggleValue,
} from './listing-state';

const colorFacet: Facet = {
  code: 'color',
  nameHe: 'צבע',
  values: [
    { code: 'beige', labelHe: 'בז׳', hex: '#D8CBB5', count: 3, selected: true },
    { code: 'gray', labelHe: 'אפור', hex: '#9A958D', count: 2, selected: false },
  ],
};

describe('listing state in the URL (CAT-08)', () => {
  it('reads a shared link and writes the same link back', () => {
    const query = {
      color: 'beige,gray',
      minWidth: '220',
      maxPrice: '6000',
      delivery: 'in_stock',
      sort: 'price_asc',
      page: '2',
    };
    const state = parseListing(query);
    expect(state).toMatchObject({
      sort: 'price_asc',
      page: 2,
      attributes: { color: ['beige', 'gray'] },
      delivery: ['in_stock'],
      ranges: { width: { min: 220, max: null }, price: { min: null, max: 6000 } },
    });
    expect(toUrlParams(state)).toEqual(query);
  });

  it('ignores malformed values instead of breaking the page', () => {
    const state = parseListing({
      sort: 'cheapest',
      page: '-3',
      minWidth: 'wide',
      color: 'Beige!,gray',
      delivery: 'soon',
    });
    expect(state).toMatchObject({ sort: 'recommended', page: 1, delivery: [], attributes: { color: ['gray'] } });
    expect(state.ranges.width.min).toBeNull();
    expect(parseListing({ page: '999' }).page).toBe(10);
  });

  it('sends the API agorot, attr.<code> and fulfillment', () => {
    const state = parseListing({ color: 'beige', minPrice: '1000', maxWidth: '300', delivery: 'pre_order' });
    expect(toApiParams(state, { category: 'sofas' }, 3)).toEqual({
      category: 'sofas',
      page: '3',
      pageSize: '24',
      'attr.color': 'beige',
      minPrice: '100000',
      maxWidth: '300',
      fulfillment: 'pre_order',
    });
  });

  it('goes back to page 1 on every change and keeps the sort when clearing', () => {
    let state = parseListing({ page: '3', sort: 'newest' });
    state = toggleValue(state, 'color', 'beige');
    expect(state.page).toBe(1);
    state = setRange(state, 'width', { min: 300, max: 200 });
    expect(state.ranges.width).toEqual({ min: 200, max: 300 });
    state = toggleDelivery(state, 'in_stock');
    expect(filterCount(state)).toBe(3);
    expect(toggleValue(state, 'color', 'beige').attributes).toEqual({});
    expect(clearFilters(state)).toMatchObject({ sort: 'newest', attributes: {}, delivery: [] });
    expect(setSort(state, 'price_desc').sort).toBe('price_desc');
  });

  it('describes active filters as removable chips', () => {
    const state = parseListing({
      color: 'beige',
      minWidth: '220',
      maxWidth: '300',
      maxPrice: '5000',
      delivery: 'in_stock',
    });
    const chips = activeChips(state, [colorFacet]);
    expect(chips.map((c) => c.label)).toEqual(['מחיר עד 5000 ₪', 'רוחב 220–300 ס״מ', 'בז׳', 'במלאי']);
    expect(filterCount(chips[2].without)).toBe(filterCount(state) - 1);
  });
});

describe('format', () => {
  it('shows prices in shekels and Hebrew counts', () => {
    expect(formatPrice(459_000)).toBe('4,590 ₪');
    expect(productCount(1)).toBe('מוצר אחד');
    expect(productCount(1200)).toBe('1,200 מוצרים');
    expect(deliveryText('in_stock', 14)).toBe('במלאי · אספקה עד 14 ימי עסקים');
    expect(deliveryText('out_of_stock', 14)).toBe('אזל');
    expect(deliveryBadge('in_stock', 14)).toBe('אספקה עד 14 ימי עסקים');
    expect(deliveryBadge('made_to_order', 45)).toBe('בייצור · עד 45 ימי עסקים');
  });
});
