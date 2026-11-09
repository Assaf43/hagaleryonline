import type { CatalogSnapshot, SnapshotCategory, SnapshotProduct, SnapshotVariant } from './catalog-snapshot.js';
import { RELATED_LIMIT, relatedProducts } from './related.js';

/**
 * Category tree (sortOrder in brackets):
 *   sofas [1] → corner-sofas, three-seater-sofas
 *   coffee-tables [2], armchairs [3], rugs [4]
 */
const CATEGORIES: Array<[id: number, slug: string, parentId: number | null, sortOrder: number]> = [
  [1, 'sofas', null, 1],
  [2, 'corner-sofas', 1, 1],
  [3, 'three-seater-sofas', 1, 2],
  [4, 'coffee-tables', null, 2],
  [5, 'armchairs', null, 3],
  [6, 'rugs', null, 4],
];
const CATEGORY_ID = Object.fromEntries(CATEGORIES.map(([id, slug]) => [slug, id]));

function categories(): Map<number, SnapshotCategory> {
  const byId = new Map<number, SnapshotCategory>(
    CATEGORIES.map(([id, slug, parentId, sortOrder]) => [
      id,
      {
        id,
        slug,
        nameHe: slug,
        parentId,
        sortOrder,
        descendantIds: new Set([id]),
        pathIds: parentId === null ? [id] : [parentId, id],
        attributeCodes: [],
      },
    ]),
  );
  for (const c of byId.values()) if (c.parentId !== null) byId.get(c.parentId)!.descendantIds.add(c.id);
  return byId;
}

let variantId = 0;
function variant(price: number, widthCm: number, color: string): SnapshotVariant {
  return {
    id: ++variantId,
    sku: `SKU-${variantId}`,
    price,
    compareAtPrice: null,
    fulfillment: 'in_stock',
    leadTimeDays: 14,
    sortOrder: 0,
    widthCm,
    depthCm: 90,
    options: new Map([['color', color]]),
  };
}

let productId = 0;
interface ProductSpec {
  id?: number;
  price?: number;
  width?: number;
  color?: string;
  rooms?: string[];
  variants?: SnapshotVariant[];
  extra?: Partial<SnapshotProduct>;
}
function product(slug: string, category: string, spec: ProductSpec = {}): SnapshotProduct {
  const id = spec.id ?? ++productId;
  return {
    id,
    slug,
    modelName: slug.toUpperCase(),
    nameHe: slug,
    categoryId: CATEGORY_ID[category]!,
    roomSlugs: new Set(spec.rooms ?? ['living-room']),
    sortOrder: 0,
    popularity: 0,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    attributes: new Map(),
    variants: spec.variants ?? [variant(spec.price ?? 1000, spec.width ?? 200, spec.color ?? 'gray')],
    image: null,
    colorImages: new Map(),
    goesWithAutofill: true,
    similarAutofill: true,
    picks: { goesWith: [], similar: [] },
    ...spec.extra,
  };
}

function snap(products: SnapshotProduct[]): CatalogSnapshot {
  const categoriesById = categories();
  return {
    products,
    categoriesById,
    categories: new Map([...categoriesById.values()].map((c) => [c.slug, c])),
    attributes: new Map(),
    rooms: new Map([['living-room', { id: 1, slug: 'living-room', nameHe: 'סלון', sortOrder: 0 }]]),
  };
}

const slugs = (products: SnapshotProduct[]) => products.map((p) => p.slug);

/** A sofa plus 2 coffee tables, 1 armchair, 1 rug, another sofa and a coffee table in another room. */
function livingRoom(extra: Partial<SnapshotProduct> = {}) {
  const sofa = product('sofa', 'corner-sofas', { color: 'beige', extra });
  const others = [
    product('coffee-1', 'coffee-tables', { price: 500 }),
    product('coffee-2', 'coffee-tables', { price: 800 }),
    product('arm-1', 'armchairs'),
    product('rug-1', 'rugs'),
    product('sofa-2', 'three-seater-sofas'),
    product('bedroom-table', 'coffee-tables', { price: 100, rooms: ['bedroom'] }),
  ];
  return { sofa, snapshot: snap([sofa, ...others]), bySlug: (s: string) => others.find((p) => p.slug === s)! };
}

describe('relatedProducts', () => {
  it('similar prefers closest price and width', () => {
    const base = product('base', 'corner-sofas', { price: 1000, width: 200 });
    const snapshot = snap([
      product('c-far', 'corner-sofas', { price: 2000, width: 300 }),
      // Cheapest variant counts: 1300 × 200, not 5000 × 400.
      product('c-mid', 'corner-sofas', { variants: [variant(5000, 400, 'gray'), variant(1300, 200, 'gray')] }),
      product('c-near', 'corner-sofas', { price: 1100, width: 210 }),
      // No width: price only.
      product('c-zero', 'corner-sofas', { price: 1050, width: 0 }),
      base,
      product('t-close', 'three-seater-sofas', { price: 1000, width: 200 }),
      product('arm', 'armchairs', { price: 1000, width: 200 }),
    ]);

    expect(slugs(relatedProducts(snapshot, base).similar)).toEqual(['c-zero', 'c-near', 'c-mid', 'c-far']);
  });

  it('similar tops up from the parent category when the leaf has fewer than 4', () => {
    const base = product('base', 'corner-sofas', { price: 1000, width: 200 });
    const snapshot = snap([
      base,
      product('c-b', 'corner-sofas', { price: 1500, width: 200 }),
      product('c-a', 'corner-sofas', { price: 1100, width: 200 }),
      product('t-b', 'three-seater-sofas', { price: 3000, width: 200 }),
      product('t-a', 'three-seater-sofas', { price: 1000, width: 200 }),
      product('arm', 'armchairs', { price: 1000, width: 200 }),
    ]);

    expect(slugs(relatedProducts(snapshot, base).similar)).toEqual(['c-a', 'c-b', 't-a', 't-b']);
  });

  it('goes-with excludes the same top-level category and round-robins', () => {
    const { sofa, snapshot } = livingRoom();
    expect(slugs(relatedProducts(snapshot, sofa).goesWith)).toEqual(['coffee-1', 'arm-1', 'rug-1', 'coffee-2']);
  });

  it('goes-with prefers a shared color, then lower price', () => {
    const sofa = product('sofa', 'corner-sofas', {
      variants: [variant(4000, 300, 'navy'), variant(4000, 300, 'beige')],
    });
    const snapshot = snap([
      sofa,
      product('ct-cheap', 'coffee-tables', { price: 300, color: 'black' }),
      product('ct-beige', 'coffee-tables', { price: 900, color: 'beige' }),
      product('ct-mid', 'coffee-tables', { price: 500, color: 'walnut' }),
      product('ct-navy', 'coffee-tables', { price: 950, color: 'navy' }),
    ]);

    expect(slugs(relatedProducts(snapshot, sofa).goesWith)).toEqual(['ct-beige', 'ct-navy', 'ct-cheap', 'ct-mid']);
  });

  it('manual picks come first in their order; hidden picks skipped', () => {
    const { snapshot, bySlug } = livingRoom();
    const sofa = snapshot.products[0]!;
    // 999 and 998 are not in the snapshot (hidden); the product itself is never shown.
    sofa.picks = {
      goesWith: [bySlug('rug-1').id, 999, sofa.id, bySlug('coffee-2').id],
      similar: [998, bySlug('sofa-2').id],
    };

    const result = relatedProducts(snapshot, sofa);
    expect(slugs(result.goesWith)).toEqual(['rug-1', 'coffee-2', 'coffee-1', 'arm-1']);
    expect(slugs(result.similar)).toEqual(['sofa-2']);
  });

  it('a manual pick may come from any category', () => {
    const { snapshot, bySlug } = livingRoom();
    const sofa = snapshot.products[0]!;
    sofa.picks = { goesWith: [bySlug('sofa-2').id], similar: [bySlug('arm-1').id] };

    const result = relatedProducts(snapshot, sofa);
    expect(slugs(result.goesWith)).toEqual(['sofa-2', 'coffee-1', 'arm-1', 'rug-1', 'coffee-2']);
    expect(slugs(result.similar)).toEqual(['arm-1', 'sofa-2']);
  });

  it('auto-fill off returns only picks', () => {
    const { snapshot, bySlug } = livingRoom({ goesWithAutofill: false, similarAutofill: false });
    const sofa = snapshot.products[0]!;
    sofa.picks = { goesWith: [bySlug('arm-1').id], similar: [] };

    const result = relatedProducts(snapshot, sofa);
    expect(slugs(result.goesWith)).toEqual(['arm-1']);
    expect(result.similar).toEqual([]);
  });

  it('never more than 8; never the product itself; stable on ties', () => {
    // Twelve identical corner sofas (ids 101..112) and ten identical coffee tables (ids 201..210), shuffled.
    const sofas = Array.from({ length: 12 }, (_, i) => product(`s-${101 + i}`, 'corner-sofas', { id: 101 + i }));
    const tables = Array.from({ length: 10 }, (_, i) => product(`t-${201 + i}`, 'coffee-tables', { id: 201 + i }));
    const self = sofas[2]!;
    const snapshot = snap([...sofas, ...tables].reverse());
    self.picks = { goesWith: [self.id], similar: [self.id] };

    const result = relatedProducts(snapshot, self);
    expect(RELATED_LIMIT).toBe(8);
    expect(slugs(result.similar)).toEqual(['s-101', 's-102', 's-104', 's-105', 's-106', 's-107', 's-108', 's-109']);
    expect(slugs(result.goesWith)).toEqual(['t-201', 't-202', 't-203', 't-204', 't-205', 't-206', 't-207', 't-208']);
  });

  it('caps manual picks at 8 too', () => {
    const tables = Array.from({ length: 10 }, (_, i) => product(`t-${301 + i}`, 'coffee-tables', { id: 301 + i }));
    const sofa = product('sofa', 'corner-sofas', {
      extra: { picks: { goesWith: tables.map((t) => t.id).reverse(), similar: [] } },
    });

    const result = relatedProducts(snap([sofa, ...tables]), sofa);
    expect(slugs(result.goesWith)).toEqual(['t-310', 't-309', 't-308', 't-307', 't-306', 't-305', 't-304', 't-303']);
  });
});
