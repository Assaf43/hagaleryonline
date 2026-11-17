import type { ImageRef, ProductSource } from '@hg/models';
import type { CatalogSnapshot, SnapshotCategory, SnapshotProduct } from '../catalog/catalog-snapshot.js';
import { queryProducts } from '../catalog/product-query.js';
import {
  categoryTile,
  productSourceLink,
  promotionUsable,
  resolveProductSource,
  type LivePromotion,
} from './product-source.js';

const NOW = new Date('2026-11-17T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);
const image = (id: number): ImageRef => ({
  url: `/media/p-${id}-960.webp`,
  srcset: '',
  avifSrcset: '',
  width: 1600,
  height: 1200,
  altHe: '',
});

function category(id: number, slug: string, parentId: number | null, pathIds: number[]): SnapshotCategory {
  return {
    id,
    slug,
    nameHe: `קטגוריה ${slug}`,
    parentId,
    sortOrder: id,
    descendantIds: new Set([id]),
    pathIds,
    attributeCodes: [],
  };
}

function product(id: number, categoryId: number, extra: Partial<SnapshotProduct> = {}): SnapshotProduct {
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
    updatedAt: daysAgo(100),
    goesWithAutofill: true,
    similarAutofill: true,
    picks: { goesWith: [], similar: [] },
    attributes: new Map(),
    variants: [
      {
        id: id * 10,
        sku: `SKU-${id}`,
        price: 100_000 + id,
        compareAtPrice: null,
        memberPrice: null,
        fulfillment: 'in_stock',
        leadTimeDays: 14,
        sortOrder: 0,
        widthCm: 200,
        depthCm: 90,
        options: new Map(),
      },
    ],
    image: image(id),
    colorImages: new Map(),
    ...extra,
  };
}

/**
 * sofas(1) → corner(2); armchairs(3); empty "tables"(4). Rooms: living-room(1), bedroom(2, product 5 only).
 * Product 9 is "hidden": not in the snapshot (the snapshot holds only products shown on the site).
 */
function buildSnapshot(): CatalogSnapshot {
  const sofas = category(1, 'sofas', null, [1]);
  const corner = category(2, 'corner-sofas', 1, [1, 2]);
  const armchairs = category(3, 'armchairs', null, [3]);
  const tables = category(4, 'tables', null, [4]);
  sofas.descendantIds.add(2);
  const categoriesById = new Map([sofas, corner, armchairs, tables].map((c) => [c.id, c]));
  const products = [
    product(1, 1, { popularity: 5, sortOrder: 3, createdAt: daysAgo(50) }),
    product(2, 2, { popularity: 9, sortOrder: 2, createdAt: daysAgo(10) }),
    product(3, 3, { popularity: 1, sortOrder: 1, createdAt: daysAgo(5) }),
    product(4, 1, { popularity: 7, sortOrder: 4, createdAt: daysAgo(1) }),
    product(5, 3, { popularity: 0, sortOrder: 5, createdAt: daysAgo(80), roomSlugs: new Set(['bedroom']) }),
  ];
  return {
    products,
    categoriesById,
    categories: new Map([...categoriesById.values()].map((c) => [c.slug, c])),
    rooms: new Map([
      ['living-room', { id: 1, slug: 'living-room', nameHe: 'סלון', sortOrder: 0 }],
      ['bedroom', { id: 2, slug: 'bedroom', nameHe: 'חדר שינה', sortOrder: 1 }],
    ]),
    attributes: new Map(),
  };
}

function promotion(over: Partial<LivePromotion> = {}): LivePromotion {
  return {
    id: 7,
    name: 'מבצע ספות',
    kind: 'automatic',
    code: null,
    discountType: 'percent',
    value: 10,
    target: 'categories',
    targetIds: [1],
    minSubtotal: 0,
    startsAt: daysAgo(3),
    endsAt: daysAgo(-3),
    usageLimit: null,
    usedCount: 0,
    active: true,
    membersOnly: false,
    appliesToMemberPrices: false,
    ...over,
  };
}

const snapshot = buildSnapshot();
const ids = (source: ProductSource, limit = 12, promotions: LivePromotion[] = []) =>
  resolveProductSource(snapshot, source, { limit, now: NOW, promotions }).map((c) => c.id);

describe('resolveProductSource', () => {
  it('best sellers and newest match the product list with that sort', () => {
    for (const sort of ['bestsellers', 'newest'] as const) {
      const listed = queryProducts(snapshot, { sort, pageSize: 4 }, { now: NOW }).items;
      const resolved = resolveProductSource(snapshot, { kind: sort }, { limit: 4, now: NOW, promotions: [] });
      expect(resolved).toEqual(listed);
    }
    expect(ids({ kind: 'bestsellers' })).toEqual([2, 4, 1, 3, 5]);
    expect(ids({ kind: 'newest' })).toEqual([4, 3, 2, 1, 5]);
  });

  it('stops at the limit', () => {
    expect(ids({ kind: 'bestsellers' }, 2)).toEqual([2, 4]);
  });

  it('a category includes its sub-categories, in the default listing order (as /api/products?category=)', () => {
    expect(ids({ kind: 'category', id: 1 })).toEqual([2, 1, 4]);
    const listed = queryProducts(snapshot, { category: 'sofas' }, { now: NOW }).items.map((c) => c.id);
    expect(ids({ kind: 'category', id: 1 })).toEqual(listed);
    expect(ids({ kind: 'category', id: 2 })).toEqual([2]);
  });

  it('a room in the default listing order', () => {
    expect(ids({ kind: 'room', id: 2 })).toEqual([5]);
    expect(ids({ kind: 'room', id: 1 })).toEqual([3, 2, 1, 4]);
  });

  it('a missing category or room gives nothing', () => {
    expect(ids({ kind: 'category', id: 99 })).toEqual([]);
    expect(ids({ kind: 'category', id: 4 })).toEqual([]);
    expect(ids({ kind: 'room', id: 99 })).toEqual([]);
  });

  it('a live promotion gives its target products: categories with sub-categories, or products', () => {
    expect(ids({ kind: 'promotion', id: 7 }, 12, [promotion()])).toEqual([2, 1, 4]);
    expect(ids({ kind: 'promotion', id: 7 }, 12, [promotion({ target: 'products', targetIds: [5, 3, 9] })])).toEqual([
      3, 5,
    ]);
  });

  it('a promotion that ended, is not started, is off or used up gives nothing', () => {
    const source: ProductSource = { kind: 'promotion', id: 7 };
    expect(ids(source, 12, [promotion({ endsAt: daysAgo(1) })])).toEqual([]);
    expect(ids(source, 12, [promotion({ startsAt: daysAgo(-1) })])).toEqual([]);
    expect(ids(source, 12, [promotion({ active: false })])).toEqual([]);
    expect(ids(source, 12, [promotion({ usageLimit: 3, usedCount: 3 })])).toEqual([]);
    expect(ids(source, 12, [])).toEqual([]);
  });

  it('a whole-order, members-only or non-automatic promotion gives nothing', () => {
    const source: ProductSource = { kind: 'promotion', id: 7 };
    expect(ids(source, 12, [promotion({ target: 'order', targetIds: [] })])).toEqual([]);
    expect(ids(source, 12, [promotion({ membersOnly: true })])).toEqual([]);
    expect(ids(source, 12, [promotion({ kind: 'coupon', code: 'SALE' })])).toEqual([]);
  });

  it('the end day is inclusive', () => {
    expect(promotionUsable(promotion({ endsAt: NOW }), NOW)).toBe(true);
    expect(promotionUsable(promotion({ endsAt: new Date(NOW.getTime() - 1) }), NOW)).toBe(false);
  });

  it('manual keeps the given order, drops hidden or unknown ids and repeats', () => {
    expect(ids({ kind: 'manual', productIds: [5, 9, 1, 5, 3, 404] })).toEqual([5, 1, 3]);
    expect(ids({ kind: 'manual', productIds: [5, 1, 3] }, 2)).toEqual([5, 1]);
    expect(ids({ kind: 'manual', productIds: [] })).toEqual([]);
  });

  it('cards are the listing cards', () => {
    const [card] = resolveProductSource(
      snapshot,
      { kind: 'manual', productIds: [2] },
      { limit: 1, now: NOW, promotions: [] },
    );
    expect(card).toMatchObject({
      id: 2,
      slug: 'p-2',
      modelName: 'P2',
      priceFrom: 100_002,
      image: image(2),
      isNew: true,
    });
  });
});

describe('productSourceLink', () => {
  it('links categories and rooms that are shown, nothing else', () => {
    expect(productSourceLink(snapshot, { kind: 'category', id: 2 })).toBe('/category/corner-sofas');
    expect(productSourceLink(snapshot, { kind: 'room', id: 2 })).toBe('/room/bedroom');
    expect(productSourceLink(snapshot, { kind: 'category', id: 4 })).toBeNull();
    expect(productSourceLink(snapshot, { kind: 'category', id: 99 })).toBeNull();
    expect(productSourceLink(snapshot, { kind: 'bestsellers' })).toBeNull();
    expect(productSourceLink(snapshot, { kind: 'promotion', id: 7 })).toBeNull();
    expect(productSourceLink(snapshot, { kind: 'manual', productIds: [1] })).toBeNull();
  });
});

describe('categoryTile', () => {
  it("is the photo of the category's first product in the default order (as /api/products?category=&pageSize=1)", () => {
    const first = queryProducts(snapshot, { category: 'sofas', pageSize: 1 }, { now: NOW }).items[0];
    expect(categoryTile(snapshot, 1, NOW)).toEqual({ slug: 'sofas', nameHe: 'קטגוריה sofas', image: first.image });
    expect(categoryTile(snapshot, 1, NOW)?.image).toEqual(image(2));
  });

  it('is null for a category that is gone or has no product shown', () => {
    expect(categoryTile(snapshot, 4, NOW)).toBeNull();
    expect(categoryTile(snapshot, 99, NOW)).toBeNull();
  });
});
