import type { CatalogSnapshot, SnapshotCategory, SnapshotProduct, SnapshotVariant } from './catalog-snapshot.js';
import { queryProducts } from './product-query.js';

const NOW = new Date('2026-10-26T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

function category(id: number, slug: string, parentId: number | null, attributeCodes: string[] = []): SnapshotCategory {
  return { id, slug, nameHe: slug, parentId, sortOrder: id, descendantIds: new Set([id]), pathIds: [], attributeCodes };
}

let variantId = 0;
function variant(price: number, width: number, options: Record<string, string>, extra: Partial<SnapshotVariant> = {}) {
  return {
    id: ++variantId,
    sku: `SKU-${variantId}`,
    price,
    compareAtPrice: null,
    fulfillment: 'in_stock' as const,
    leadTimeDays: 14,
    sortOrder: 0,
    widthCm: width,
    depthCm: 90,
    options: new Map(Object.entries(options)),
    ...extra,
  };
}

function product(
  id: number,
  categoryId: number,
  variants: SnapshotVariant[],
  extra: Partial<SnapshotProduct> = {},
): SnapshotProduct {
  return {
    id,
    slug: `p-${id}`,
    modelName: `P${id}`,
    nameHe: `מוצר ${id}`,
    categoryId,
    roomSlugs: new Set(['living-room']),
    sortOrder: id,
    popularity: 0,
    createdAt: daysAgo(100),
    attributes: new Map(),
    variants,
    image: null,
    ...extra,
  };
}

/** sofas(1) → corner(2); armchairs(3). Colors per variant, style per product. */
function buildSnapshot(products: SnapshotProduct[]): CatalogSnapshot {
  const sofas = category(1, 'sofas', null, ['color', 'style']);
  const corner = category(2, 'corner-sofas', 1);
  const armchairs = category(3, 'armchairs', null, ['color']);
  sofas.descendantIds.add(2);
  sofas.pathIds = [1];
  corner.pathIds = [1, 2];
  armchairs.pathIds = [3];
  const categoriesById = new Map([sofas, corner, armchairs].map((c) => [c.id, c]));
  const values = (entries: [string, string, number][]) =>
    new Map(entries.map(([code, labelHe, sortOrder]) => [code, { code, labelHe, hex: null, sortOrder }]));
  return {
    products,
    categoriesById,
    categories: new Map([...categoriesById.values()].map((c) => [c.slug, c])),
    rooms: new Map([['living-room', { id: 1, slug: 'living-room', nameHe: 'סלון', sortOrder: 0 }]]),
    attributes: new Map([
      [
        'color',
        {
          code: 'color',
          nameHe: 'צבע',
          scope: 'variant',
          filterable: true,
          sortOrder: 0,
          values: values([
            ['beige', 'בז׳', 0],
            ['gray', 'אפור', 1],
            ['olive', 'זית', 2],
          ]),
        },
      ],
      [
        'style',
        {
          code: 'style',
          nameHe: 'סגנון',
          scope: 'product',
          filterable: true,
          sortOrder: 1,
          values: values([
            ['modern', 'מודרני', 0],
            ['nordic', 'נורדי', 1],
          ]),
        },
      ],
    ]),
  };
}

const run = (
  snapshot: CatalogSnapshot,
  query: Parameters<typeof queryProducts>[1],
  searchScores?: Map<number, number>,
) => queryProducts(snapshot, query, { now: NOW, searchScores });

describe('queryProducts', () => {
  const alba = product(1, 2, [variant(500_000, 300, { color: 'beige' }), variant(450_000, 260, { color: 'gray' })], {
    attributes: new Map([['style', new Set(['modern'])]]),
    popularity: 10,
  });
  const nora = product(2, 1, [variant(380_000, 220, { color: 'olive' })], {
    attributes: new Map([['style', new Set(['nordic'])]]),
    popularity: 50,
    createdAt: daysAgo(3),
  });
  const luna = product(3, 3, [variant(150_000, 78, { color: 'olive' })]);
  const snapshot = buildSnapshot([alba, nora, luna]);

  it('includes sub-categories when listing a parent category', () => {
    expect(run(snapshot, { category: 'sofas' }).items.map((i) => i.modelName)).toEqual(['P1', 'P2']);
    expect(run(snapshot, { category: 'corner-sofas' }).items.map((i) => i.modelName)).toEqual(['P1']);
  });

  it('returns nothing for an unknown category or room', () => {
    expect(run(snapshot, { category: 'nope' }).total).toBe(0);
    expect(run(snapshot, { room: 'kitchen' }).total).toBe(0);
  });

  it('needs one variant that passes every variant filter at once', () => {
    // ALBA has a beige 300 cm and a gray 260 cm — no beige 260 cm.
    expect(run(snapshot, { attributes: { color: ['beige'] }, maxWidth: 270 }).total).toBe(0);
    expect(run(snapshot, { attributes: { color: ['gray'] }, maxWidth: 270 }).items[0].modelName).toBe('P1');
  });

  it('prices the card by the cheapest variant that matches the filters', () => {
    const [card] = run(snapshot, { category: 'corner-sofas', attributes: { color: ['beige'] } }).items;
    expect(card.priceFrom).toBe(500_000);
    expect(card.hasPriceRange).toBe(true);
    expect(card.swatches.map((s) => s.code)).toEqual(['beige', 'gray']);
  });

  it('counts each facet as if its own selection were cleared (disjunctive)', () => {
    const result = run(snapshot, { category: 'sofas', attributes: { color: ['olive'] } });
    expect(result.total).toBe(1);
    const color = result.facets.find((f) => f.code === 'color')!;
    expect(color.values.map((v) => [v.code, v.count, v.selected])).toEqual([
      ['beige', 1, false],
      ['gray', 1, false],
      ['olive', 1, true],
    ]);
    const style = result.facets.find((f) => f.code === 'style')!;
    expect(style.values.map((v) => [v.code, v.count])).toEqual([['nordic', 1]]);
  });

  it('only shows facets of the categories in scope, and hides empty values', () => {
    const result = run(snapshot, { category: 'armchairs' });
    expect(result.facets.map((f) => f.code)).toEqual(['color']);
    expect(result.facets[0].values.map((v) => v.code)).toEqual(['olive']);
  });

  it('reports range bounds that ignore their own filter', () => {
    const result = run(snapshot, { category: 'sofas', minWidth: 250 });
    expect(result.total).toBe(1);
    expect(result.ranges.width).toEqual({ min: 220, max: 300 });
    expect(result.ranges.price).toEqual({ min: 450_000, max: 500_000 });
  });

  it('sorts by price, popularity and date', () => {
    const names = (sort: 'price_asc' | 'price_desc' | 'bestsellers' | 'newest') =>
      run(snapshot, { sort }).items.map((i) => i.modelName);
    expect(names('price_asc')).toEqual(['P3', 'P2', 'P1']);
    expect(names('price_desc')).toEqual(['P1', 'P2', 'P3']);
    expect(names('bestsellers')).toEqual(['P2', 'P1', 'P3']);
    expect(names('newest')[0]).toBe('P2');
  });

  it('orders search results by relevance unless a sort is chosen', () => {
    const scores = new Map([
      [3, 2],
      [1, 1],
    ]);
    expect(run(snapshot, {}, scores).items.map((i) => i.modelName)).toEqual(['P3', 'P1']);
    expect(run(snapshot, { sort: 'price_desc' }, scores).items.map((i) => i.modelName)).toEqual(['P1', 'P3']);
  });

  it('pages the results', () => {
    const result = run(snapshot, { sort: 'price_asc', page: 2, pageSize: 2 });
    expect(result.items.map((i) => i.modelName)).toEqual(['P1']);
    expect([result.total, result.page, result.pageSize]).toEqual([3, 2, 2]);
  });

  it('marks discounts, new products and the fastest delivery', () => {
    const sale = product(4, 3, [
      variant(
        80_000,
        60,
        { color: 'gray' },
        { compareAtPrice: 100_000, fulfillment: 'made_to_order', leadTimeDays: 40 },
      ),
      variant(90_000, 60, { color: 'beige' }, { leadTimeDays: 7 }),
    ]);
    const [card] = run(buildSnapshot([sale, nora]), { category: 'armchairs' }).items;
    expect(card.discountPercent).toBe(20);
    expect(card.compareAtFrom).toBe(100_000);
    expect([card.fulfillment, card.leadTimeDays]).toEqual(['in_stock', 7]);
    expect(run(buildSnapshot([nora]), {}).items[0].isNew).toBe(true);
  });

  it('filters and counts delivery modes', () => {
    const preOrder = product(5, 3, [variant(100_000, 60, { color: 'gray' }, { fulfillment: 'pre_order' })]);
    const result = run(buildSnapshot([luna, preOrder]), { fulfillment: ['pre_order'] });
    expect(result.items.map((i) => i.modelName)).toEqual(['P5']);
    expect(result.fulfillment).toEqual([
      { mode: 'in_stock', count: 1, selected: false },
      { mode: 'pre_order', count: 1, selected: true },
    ]);
  });
});
