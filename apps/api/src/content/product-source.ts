import type { HomeCategoryTile, ProductCard, ProductSort, ProductSource } from '@hg/models';
import type { CatalogSnapshot, SnapshotCategory, SnapshotProduct } from '../catalog/catalog-snapshot.js';
import { sortUnfiltered, toCard } from '../catalog/product-query.js';
import { promotionEnded, type PromotionRule } from '../promotions/discount-engine.js';

/**
 * Product sources (Phase 8 §4.6, §9 "Promotion source", decision 98): what a home product row and a landing-page grid
 * (Task 11) show. Pure: the catalog snapshot (only products shown on the site, decisions 60 / 62), the promotions and
 * the clock come from the caller, so cards follow the catalog snapshot's own refresh.
 */

/**
 * A promotion as the source reads it: the automatic promotions with their uses (`PromotionsService.automatic`, the
 * same read the cart prices with), so "used up" means the same thing here as at checkout.
 */
export type LivePromotion = PromotionRule;

export interface ProductSourceOptions {
  /** Most cards to return. */
  limit: number;
  now: Date;
  promotions: readonly LivePromotion[];
}

/**
 * A promotion a source may show: automatic, not members-only, on categories or products (never the whole order),
 * active and inside its dates now, and not used up.
 */
export function promotionUsable(promotion: LivePromotion, now: Date): boolean {
  return (
    promotion.kind === 'automatic' &&
    !promotion.membersOnly &&
    promotion.target !== 'order' &&
    !promotionEnded(promotion, now)
  );
}

/**
 * The cards of a source, in its order, at most `limit`: best sellers / newest like `/api/products?sort=…`; a category
 * (with its sub-categories) or a room in the default listing order ("recommended"); a promotion's target products in
 * that order, only while the promotion is usable (`promotionUsable`, else none); manual ids in the given order, ids
 * not shown on the site dropped (and repeats once). A category or room that is gone or hidden gives none.
 */
export function resolveProductSource(
  snapshot: CatalogSnapshot,
  source: ProductSource,
  opts: ProductSourceOptions,
): ProductCard[] {
  const limit = Math.max(0, Math.floor(opts.limit));
  const cards = (products: SnapshotProduct[]) =>
    products.slice(0, limit).map((p) => toCard(snapshot, p, p.variants, opts.now, undefined));
  const ranked = (products: SnapshotProduct[], sort: ProductSort) => cards(sortUnfiltered(products, sort, opts.now));

  switch (source.kind) {
    case 'bestsellers':
    case 'newest':
      return ranked(snapshot.products, source.kind);
    case 'category': {
      const category = snapshot.categoriesById.get(source.id);
      return category ? ranked(productsOfCategory(snapshot, category), 'recommended') : [];
    }
    case 'room': {
      const room = roomById(snapshot, source.id);
      return room
        ? ranked(
            snapshot.products.filter((p) => p.roomSlugs.has(room.slug)),
            'recommended',
          )
        : [];
    }
    case 'promotion': {
      const promotion = opts.promotions.find((p) => p.id === source.id);
      if (!promotion || !promotionUsable(promotion, opts.now)) return [];
      return ranked(promotionProducts(snapshot, promotion), 'recommended');
    }
    case 'manual': {
      const byId = new Map(snapshot.products.map((p) => [p.id, p]));
      const picked = [...new Set(source.productIds)].map((id) => byId.get(id)).filter((p) => p !== undefined);
      return cards(picked);
    }
  }
}

/** "לכל המוצרים" of a source: its listing page for a category or a room that is shown, else null (spec §9). */
export function productSourceLink(snapshot: CatalogSnapshot, source: ProductSource): string | null {
  if (source.kind === 'category') {
    const category = snapshot.categoriesById.get(source.id);
    return category && productsOfCategory(snapshot, category).length > 0 ? `/category/${category.slug}` : null;
  }
  if (source.kind === 'room') {
    const room = roomById(snapshot, source.id);
    return room && snapshot.products.some((p) => p.roomSlugs.has(room.slug)) ? `/room/${room.slug}` : null;
  }
  return null;
}

/**
 * A furniture-type tile (§4.6, same rule as today's home page): the photo of the category's first product in the
 * default listing order (what `/api/products?category=<slug>&pageSize=1` returns first); null when the category is
 * gone, hidden or has no product shown.
 */
export function categoryTile(snapshot: CatalogSnapshot, categoryId: number, now: Date): HomeCategoryTile | null {
  const category = snapshot.categoriesById.get(categoryId);
  if (!category) return null;
  const [first] = sortUnfiltered(productsOfCategory(snapshot, category), 'recommended', now);
  if (!first) return null;
  return { slug: category.slug, nameHe: category.nameHe, image: first.image };
}

function productsOfCategory(snapshot: CatalogSnapshot, category: SnapshotCategory): SnapshotProduct[] {
  return snapshot.products.filter((p) => category.descendantIds.has(p.categoryId));
}

function roomById(snapshot: CatalogSnapshot, id: number) {
  return [...snapshot.rooms.values()].find((r) => r.id === id);
}

/** The products a promotion targets, as the discount engine counts them: a category includes its sub-categories. */
function promotionProducts(snapshot: CatalogSnapshot, promotion: LivePromotion): SnapshotProduct[] {
  const targets = new Set(promotion.targetIds);
  if (promotion.target === 'products') return snapshot.products.filter((p) => targets.has(p.id));
  return snapshot.products.filter((p) =>
    (snapshot.categoriesById.get(p.categoryId)?.pathIds ?? []).some((id) => targets.has(id)),
  );
}
