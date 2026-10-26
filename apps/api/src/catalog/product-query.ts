import type {
  Facet,
  FulfillmentMode,
  NumericRange,
  ProductCard,
  ProductListQuery,
  ProductListResponse,
  Swatch,
} from '@hg/models';
import type { CatalogSnapshot, SnapshotProduct, SnapshotVariant } from './catalog-snapshot.js';

export const DEFAULT_PAGE_SIZE = 24;
export const MAX_PAGE_SIZE = 60;
const NEW_PRODUCT_DAYS = 30;
const FULFILLMENT_ORDER: FulfillmentMode[] = ['in_stock', 'pre_order', 'made_to_order', 'out_of_stock'];

/** A filter that facet counts can leave out: an attribute code or one of the fixed filters. */
type FilterKey = string;
const PRICE = '#price';
const WIDTH = '#width';
const DEPTH = '#depth';
const FULFILLMENT = '#fulfillment';

export interface ProductQueryContext {
  /** Search hits (product id → relevance) when the query has `q`; undefined = no text search. */
  searchScores?: Map<number, number>;
  now: Date;
}

/**
 * Filters, facets, sorts and pages the catalog (CAT-03..CAT-09).
 *
 * A product matches when its product-level attributes pass and at least one of its variants
 * passes every variant-level filter (price, size, color, fabric, delivery). Facet counts for a
 * group ignore that group's own selection, so customers can widen a choice (disjunctive facets).
 */
export function queryProducts(
  snapshot: CatalogSnapshot,
  query: ProductListQuery,
  context: ProductQueryContext,
): ProductListResponse {
  const base = baseProducts(snapshot, query, context);
  const filters = buildFilters(snapshot, query);

  const matches = base.filter((p) => matchingVariants(p, filters).length > 0);
  const sorted = sortProducts(matches, query, filters, context);

  const pageSize = Math.min(Math.max(query.pageSize ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);
  const page = Math.max(query.page ?? 1, 1);
  const pageItems = sorted.slice((page - 1) * pageSize, page * pageSize);

  return {
    items: pageItems.map((p) => toCard(snapshot, p, matchingVariants(p, filters), context.now)),
    total: matches.length,
    page,
    pageSize,
    facets: buildFacets(snapshot, base, filters),
    fulfillment: buildFulfillmentFacet(base, filters),
    ranges: {
      price: rangeOf(base, filters, PRICE, (v) => v.price),
      width: rangeOf(base, filters, WIDTH, (v) => v.widthCm),
      depth: rangeOf(base, filters, DEPTH, (v) => v.depthCm),
    },
  };
}

// ---------- scope: category, room, search ----------

function baseProducts(snapshot: CatalogSnapshot, query: ProductListQuery, context: ProductQueryContext) {
  const category = query.category ? snapshot.categories.get(query.category) : undefined;
  if (query.category && !category) return [];
  if (query.room && !snapshot.rooms.has(query.room)) return [];

  return snapshot.products.filter(
    (p) =>
      (!category || category.descendantIds.has(p.categoryId)) &&
      (!query.room || p.roomSlugs.has(query.room)) &&
      (!context.searchScores || context.searchScores.has(p.id)),
  );
}

// ---------- filters ----------

interface Filters {
  /** Product-level attribute filters: code → accepted value codes. */
  productAttrs: Map<string, Set<string>>;
  /** Variant-level checks, keyed so a facet can leave its own one out. */
  variantChecks: Map<FilterKey, (v: SnapshotVariant) => boolean>;
  /** Selected values per attribute code and for delivery, to flag them in the facets. */
  selected: Map<FilterKey, Set<string>>;
}

function buildFilters(snapshot: CatalogSnapshot, query: ProductListQuery): Filters {
  const productAttrs = new Map<string, Set<string>>();
  const variantChecks = new Map<FilterKey, (v: SnapshotVariant) => boolean>();
  const selected = new Map<FilterKey, Set<string>>();

  for (const [code, values] of Object.entries(query.attributes ?? {})) {
    const attribute = snapshot.attributes.get(code);
    if (!attribute || values.length === 0) continue;
    const accepted = new Set(values);
    selected.set(code, accepted);
    if (attribute.scope === 'product') productAttrs.set(code, accepted);
    else variantChecks.set(code, (v) => accepted.has(v.options.get(code) ?? ''));
  }

  addRange(variantChecks, PRICE, query.minPrice, query.maxPrice, (v) => v.price);
  addRange(variantChecks, WIDTH, query.minWidth, query.maxWidth, (v) => v.widthCm);
  addRange(variantChecks, DEPTH, query.minDepth, query.maxDepth, (v) => v.depthCm);

  if (query.fulfillment?.length) {
    const accepted = new Set<string>(query.fulfillment);
    selected.set(FULFILLMENT, accepted);
    variantChecks.set(FULFILLMENT, (v) => accepted.has(v.fulfillment));
  }

  return { productAttrs, variantChecks, selected };
}

function addRange(
  checks: Filters['variantChecks'],
  key: FilterKey,
  min: number | undefined,
  max: number | undefined,
  pick: (v: SnapshotVariant) => number,
) {
  if (min === undefined && max === undefined) return;
  checks.set(key, (v) => (min === undefined || pick(v) >= min) && (max === undefined || pick(v) <= max));
}

/** Variants of `p` that pass every filter except `skip`; empty when a product-level filter fails. */
function matchingVariants(p: SnapshotProduct, filters: Filters, skip?: FilterKey): SnapshotVariant[] {
  for (const [code, accepted] of filters.productAttrs) {
    if (code === skip) continue;
    const values = p.attributes.get(code);
    if (!values || ![...values].some((value) => accepted.has(value))) return [];
  }
  return p.variants.filter((v) => {
    for (const [key, check] of filters.variantChecks) {
      if (key !== skip && !check(v)) return false;
    }
    return true;
  });
}

// ---------- facets ----------

function buildFacets(snapshot: CatalogSnapshot, base: SnapshotProduct[], filters: Filters): Facet[] {
  const facets: Facet[] = [];

  for (const code of relevantAttributeCodes(snapshot, base)) {
    const attribute = snapshot.attributes.get(code);
    if (!attribute?.filterable) continue;

    const selected = filters.selected.get(code);
    const counts = new Map<string, number>();
    for (const p of base) {
      const variants = matchingVariants(p, filters, code);
      if (variants.length === 0) continue;
      const values =
        attribute.scope === 'product'
          ? (p.attributes.get(code) ?? new Set<string>())
          : new Set(variants.map((v) => v.options.get(code)).filter((value): value is string => !!value));
      for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    }

    const values = [...attribute.values.values()]
      .filter((value) => (counts.get(value.code) ?? 0) > 0 || selected?.has(value.code))
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((value) => ({
        code: value.code,
        labelHe: value.labelHe,
        hex: value.hex,
        count: counts.get(value.code) ?? 0,
        selected: selected?.has(value.code) ?? false,
      }));

    if (values.length > 0) facets.push({ code, nameHe: attribute.nameHe, values });
  }

  return facets;
}

/** Attributes linked to the categories of the products in scope (and those categories' ancestors). */
function relevantAttributeCodes(snapshot: CatalogSnapshot, base: SnapshotProduct[]): string[] {
  const codes = new Set<string>();
  const seen = new Set<number>();
  for (const p of base) {
    if (seen.has(p.categoryId)) continue;
    seen.add(p.categoryId);
    for (const id of snapshot.categoriesById.get(p.categoryId)?.pathIds ?? []) {
      for (const code of snapshot.categoriesById.get(id)?.attributeCodes ?? []) codes.add(code);
    }
  }
  return [...codes].sort(
    (a, b) => (snapshot.attributes.get(a)?.sortOrder ?? 0) - (snapshot.attributes.get(b)?.sortOrder ?? 0),
  );
}

function buildFulfillmentFacet(base: SnapshotProduct[], filters: Filters): ProductListResponse['fulfillment'] {
  const counts = new Map<FulfillmentMode, number>();
  for (const p of base) {
    const modes = new Set(matchingVariants(p, filters, FULFILLMENT).map((v) => v.fulfillment));
    for (const mode of modes) counts.set(mode, (counts.get(mode) ?? 0) + 1);
  }
  const selected = filters.selected.get(FULFILLMENT);
  return FULFILLMENT_ORDER.filter((mode) => counts.has(mode) || selected?.has(mode)).map((mode) => ({
    mode,
    count: counts.get(mode) ?? 0,
    selected: selected?.has(mode) ?? false,
  }));
}

function rangeOf(
  base: SnapshotProduct[],
  filters: Filters,
  key: FilterKey,
  pick: (v: SnapshotVariant) => number,
): NumericRange | null {
  let min = Infinity;
  let max = -Infinity;
  for (const p of base) {
    for (const v of matchingVariants(p, filters, key)) {
      const value = pick(v);
      if (value < min) min = value;
      if (value > max) max = value;
    }
  }
  return min === Infinity ? null : { min, max };
}

// ---------- sorting ----------

function sortProducts(
  products: SnapshotProduct[],
  query: ProductListQuery,
  filters: Filters,
  context: ProductQueryContext,
): SnapshotProduct[] {
  const minPrice = new Map(products.map((p) => [p.id, Math.min(...matchingVariants(p, filters).map((v) => v.price))]));
  const byRecommended = (a: SnapshotProduct, b: SnapshotProduct) =>
    a.sortOrder - b.sortOrder || b.createdAt.getTime() - a.createdAt.getTime() || a.id - b.id;

  const sort = query.sort ?? (context.searchScores ? 'relevance' : 'recommended');
  const compare: Record<string, (a: SnapshotProduct, b: SnapshotProduct) => number> = {
    relevance: (a, b) =>
      (context.searchScores?.get(b.id) ?? 0) - (context.searchScores?.get(a.id) ?? 0) || byRecommended(a, b),
    recommended: byRecommended,
    bestsellers: (a, b) => b.popularity - a.popularity || byRecommended(a, b),
    price_asc: (a, b) => minPrice.get(a.id)! - minPrice.get(b.id)! || byRecommended(a, b),
    price_desc: (a, b) => minPrice.get(b.id)! - minPrice.get(a.id)! || byRecommended(a, b),
    newest: (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || a.id - b.id,
  };
  return [...products].sort(compare[sort] ?? byRecommended);
}

// ---------- cards ----------

function toCard(snapshot: CatalogSnapshot, p: SnapshotProduct, matching: SnapshotVariant[], now: Date): ProductCard {
  const cheapest = matching.reduce((best, v) => (v.price < best.price ? v : best));
  const sellable = matching.filter((v) => v.fulfillment !== 'out_of_stock');
  const fastest = (sellable.length ? sellable : matching).reduce((best, v) =>
    v.leadTimeDays < best.leadTimeDays ? v : best,
  );
  const discount =
    cheapest.compareAtPrice && cheapest.compareAtPrice > cheapest.price
      ? Math.round((1 - cheapest.price / cheapest.compareAtPrice) * 100)
      : null;

  return {
    slug: p.slug,
    modelName: p.modelName,
    nameHe: p.nameHe,
    priceFrom: cheapest.price,
    compareAtFrom: discount ? cheapest.compareAtPrice : null,
    discountPercent: discount,
    hasPriceRange: new Set(p.variants.map((v) => v.price)).size > 1,
    swatches: swatchesOf(snapshot, p),
    image: p.image,
    fulfillment: fastest.fulfillment,
    leadTimeDays: fastest.leadTimeDays,
    isNew: now.getTime() - p.createdAt.getTime() < NEW_PRODUCT_DAYS * 24 * 60 * 60 * 1000,
  };
}

function swatchesOf(snapshot: CatalogSnapshot, p: SnapshotProduct): Swatch[] {
  const colors = snapshot.attributes.get('color');
  if (!colors) return [];
  const codes = new Set(p.variants.map((v) => v.options.get('color')).filter((c): c is string => !!c));
  return [...codes]
    .map((code) => colors.values.get(code))
    .filter((value) => !!value)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((value) => ({ code: value.code, labelHe: value.labelHe, hex: value.hex }));
}
