import type { FulfillmentMode, OptionAxis, VariantDetail } from '@hg/models';
import {
  adjustmentNotice,
  optionStates,
  paramsToSelection,
  pickOption,
  resolveSelection,
  selectionToParams,
} from './variant-selection';

const axes: OptionAxis[] = [
  {
    code: 'color',
    nameHe: 'צבע',
    values: [
      { code: 'beige', labelHe: 'בז׳', hex: '#D8CBB5' },
      { code: 'green', labelHe: 'ירוק', hex: '#5B7B5A' },
    ],
  },
  {
    code: 'size',
    nameHe: 'גודל',
    values: [
      { code: '240', labelHe: '240 ס״מ', hex: null },
      { code: '280', labelHe: '280 ס״מ', hex: null },
    ],
  },
  {
    code: 'fabric',
    nameHe: 'בד',
    values: [
      { code: 'linen', labelHe: 'פשתן', hex: null },
      { code: 'velvet', labelHe: 'קטיפה', hex: null },
    ],
  },
];

function variant(
  sku: string,
  options: Record<string, string>,
  fulfillment: FulfillmentMode,
  price: number,
): VariantDetail {
  return {
    sku,
    price,
    compareAtPrice: null,
    inStock: fulfillment === 'in_stock',
    fulfillment,
    leadTimeDays: 0,
    productionDays: null,
    expectedAt: null,
    dimensions: { widthCm: 0, depthCm: 0, heightCm: 0 } as VariantDetail['dimensions'],
    options,
    images: [],
  };
}

const v1 = variant('V1', { color: 'beige', size: '240', fabric: 'linen' }, 'in_stock', 3000);
const v2 = variant('V2', { color: 'beige', size: '280', fabric: 'linen' }, 'in_stock', 3500);
const v3 = variant('V3', { color: 'green', size: '240', fabric: 'linen' }, 'in_stock', 3200);
const v4 = variant('V4', { color: 'green', size: '280', fabric: 'velvet' }, 'out_of_stock', 4000);
const v5 = variant('V5', { color: 'beige', size: '240', fabric: 'velvet' }, 'pre_order', 3800);
const v6 = variant('V6', { color: 'green', size: '280', fabric: 'linen' }, 'made_to_order', 3600);
const variants = [v4, v6, v2, v5, v3, v1];

describe('variant selection', () => {
  it('default prefers in stock, then lowest price', () => {
    expect(resolveSelection(variants, axes, {}).variant.sku).toBe('V1');
  });

  it('default falls back to API order on a full tie', () => {
    const a = variant('A', { color: 'beige' }, 'in_stock', 100);
    const b = variant('B', { color: 'green' }, 'in_stock', 100);
    expect(resolveSelection([b, a], axes, {}).variant.sku).toBe('B');
  });

  it('default for a product with no axes is its only variant', () => {
    const only = variant('ONLY', {}, 'in_stock', 100);
    const r = resolveSelection([only], [], {});
    expect(r.variant).toBe(only);
    expect(r.adjusted).toEqual([]);
    expect(selectionToParams(only, [])).toEqual({});
  });

  it('paramsToSelection ignores unknown axes and values', () => {
    expect(paramsToSelection({ color: 'pink', foo: '1', size: '280' }, axes)).toEqual({ size: '280' });
  });

  it('resolveSelection with a full existing combination returns it, adjusted []', () => {
    const r = resolveSelection(variants, axes, { color: 'green', size: '280', fabric: 'velvet' });
    expect(r.variant.sku).toBe('V4');
    expect(r.adjusted).toEqual([]);
  });

  it('resolveSelection with a partial combination ranks by matches then axis order', () => {
    expect(resolveSelection(variants, axes, { color: 'green', fabric: 'velvet' }).variant.sku).toBe('V4');
    expect(resolveSelection(variants, axes, { size: '280' }).variant.sku).toBe('V2');
    // No exact match: V2 (color, size) beats V5 (color, fabric) by axis order.
    const r = resolveSelection(variants, axes, { color: 'beige', size: '280', fabric: 'velvet' });
    expect(r.variant.sku).toBe('V2');
    expect(r.adjusted).toEqual(['fabric']);
  });

  it('pickOption to an available value changes only that axis', () => {
    const r = pickOption(variants, axes, v1, 'color', 'green');
    expect(r.variant.sku).toBe('V3');
    expect(r.adjusted).toEqual([]);
  });

  it('pickOption to an unavailable value keeps it and moves the fewest other axes', () => {
    const vv = [v1, v2, v3, v5];
    // From beige/280/linen pick velvet: only V5 has velvet; it moves size.
    const r = pickOption(vv, axes, v2, 'fabric', 'velvet');
    expect(r.variant.sku).toBe('V5');
    expect(r.adjusted).toEqual(['size']);
    // Moving two axes when nothing closer exists.
    const far = pickOption([v2, v4], axes, v2, 'fabric', 'velvet');
    expect(far.variant.sku).toBe('V4');
    expect(far.adjusted).toEqual(['color']);
  });

  it('pickOption tie between two fallbacks is broken by axis order, then availability, then price', () => {
    // Axis order: V5 keeps color (earlier) and moves size; V4 keeps size and moves color.
    const byAxis = pickOption(variants, axes, v2, 'fabric', 'velvet');
    expect(byAxis.variant.sku).toBe('V5');
    expect(byAxis.adjusted).toEqual(['size']);

    // Identical matches: availability, then price.
    const cur = variant('C', { color: 'beige', size: '240', fabric: 'linen' }, 'in_stock', 1);
    const tied = [
      variant('X1', { color: 'green', size: '240', fabric: 'velvet' }, 'made_to_order', 100),
      variant('X2', { color: 'green', size: '240', fabric: 'velvet' }, 'pre_order', 900),
      variant('X3', { color: 'green', size: '240', fabric: 'velvet' }, 'pre_order', 800),
    ];
    expect(pickOption(tied, axes, cur, 'fabric', 'velvet').variant.sku).toBe('X3');
  });

  it('optionStates marks missing and out-of-stock combinations unavailable', () => {
    const s = optionStates(variants, axes, v1);
    expect(s['color']).toEqual({ beige: 'available', green: 'available' });
    expect(s['size']).toEqual({ '240': 'available', '280': 'available' });
    expect(s['fabric']).toEqual({ linen: 'available', velvet: 'available' });
    // green/240/velvet does not exist.
    expect(optionStates(variants, axes, v3)['fabric']['velvet']).toBe('unavailable');
    // green/280/velvet exists but is out of stock.
    expect(optionStates(variants, axes, v6)['fabric']['velvet']).toBe('unavailable');
  });

  it('selectionToParams and paramsToSelection round-trip', () => {
    const params = selectionToParams(v5, axes);
    expect(params).toEqual({ color: 'beige', size: '240', fabric: 'velvet' });
    expect(paramsToSelection(params, axes)).toEqual(params);
  });

  it('adjustmentNotice text', () => {
    expect(adjustmentNotice([], axes, v1)).toBeNull();
    expect(adjustmentNotice(['size'], axes, v2)).toBe('הצירוף שבחרתם לא זמין, ולכן עדכנו: גודל — 280 ס״מ');
    expect(adjustmentNotice(['color', 'fabric'], axes, v3)).toBe(
      'הצירוף שבחרתם לא זמין, ולכן עדכנו: צבע — ירוק, בד — פשתן',
    );
  });

  describe('ranking steps', () => {
    const wanted = { color: 'beige', size: '280', fabric: 'velvet' };
    const earlierAxis = variant('A', { color: 'beige', size: '240', fabric: 'velvet' }, 'made_to_order', 9000);
    const laterAxis = variant('B', { color: 'green', size: '280', fabric: 'velvet' }, 'in_stock', 1000);

    it('axis order beats availability and price (resolveSelection)', () => {
      expect(resolveSelection([laterAxis, earlierAxis], axes, wanted).variant.sku).toBe('A');
    });

    it('axis order beats availability and price (pickOption)', () => {
      const current = variant('C', { color: 'beige', size: '280', fabric: 'linen' }, 'in_stock', 1);
      const r = pickOption([laterAxis, earlierAxis], axes, current, 'fabric', 'velvet');
      expect(r.variant.sku).toBe('A');
      expect(r.adjusted).toEqual(['size']);
    });

    it('match count beats axis order', () => {
      const oneEarly = variant('A', { color: 'beige', size: '240', fabric: 'linen' }, 'in_stock', 100);
      const twoLate = variant('B', { color: 'green', size: '280', fabric: 'velvet' }, 'out_of_stock', 9000);
      expect(resolveSelection([oneEarly, twoLate], axes, wanted).variant.sku).toBe('B');
    });
  });
});
