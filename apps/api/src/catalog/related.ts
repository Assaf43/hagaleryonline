import type { CatalogSnapshot, SnapshotProduct, SnapshotVariant } from './catalog-snapshot.js';

/** Most cards in one related row (spec §4.1). */
export const RELATED_LIMIT = 8;
/** Below this many leaf-category matches, "similar" is topped up from the top-level category. */
const SIMILAR_LEAF_MIN = 4;

/**
 * The two related rows of a product page (PRD-12, decision 67). Each row is this product's visible
 * manual picks in their order, then — when that row's auto-fill is on — the automatic results not
 * already in it, up to RELATED_LIMIT. The product itself never appears. Pure: runs on the snapshot.
 */
export function relatedProducts(
  snapshot: CatalogSnapshot,
  product: SnapshotProduct,
): { goesWith: SnapshotProduct[]; similar: SnapshotProduct[] } {
  const byId = new Map(snapshot.products.map((p) => [p.id, p]));
  const row = (picks: number[], autofill: boolean, auto: () => SnapshotProduct[]) => {
    const result: SnapshotProduct[] = [];
    const seen = new Set([product.id]);
    const add = (p: SnapshotProduct | undefined) => {
      if (!p || seen.has(p.id) || result.length >= RELATED_LIMIT) return;
      seen.add(p.id);
      result.push(p);
    };
    for (const id of picks) add(byId.get(id));
    if (autofill && result.length < RELATED_LIMIT) for (const p of auto()) add(p);
    return result;
  };

  return {
    goesWith: row(product.picks.goesWith, product.goesWithAutofill, () => autoGoesWith(snapshot, product)),
    similar: row(product.picks.similar, product.similarAutofill, () => autoSimilar(snapshot, product)),
  };
}

/**
 * Same leaf category, closest first by |Δprice|/price + |Δwidth|/width (cheapest variants; the width
 * term is dropped when either width is 0). Fewer than 4 → the rest of the top-level category follows.
 */
function autoSimilar(snapshot: CatalogSnapshot, product: SnapshotProduct): SnapshotProduct[] {
  const self = cheapest(product);
  const score = (p: SnapshotProduct) => {
    const other = cheapest(p);
    const price = self.price > 0 ? Math.abs(other.price - self.price) / self.price : 0;
    const width = self.widthCm > 0 && other.widthCm > 0 ? Math.abs(other.widthCm - self.widthCm) / self.widthCm : 0;
    return price + width;
  };
  const closest = (products: SnapshotProduct[]) =>
    products
      .map((p) => ({ p, score: score(p) }))
      .sort((a, b) => a.score - b.score || a.p.id - b.p.id)
      .map(({ p }) => p);

  const others = snapshot.products.filter((p) => p.id !== product.id);
  const leaf = closest(others.filter((p) => p.categoryId === product.categoryId));
  if (leaf.length >= SIMILAR_LEAF_MIN) return leaf;

  const topLevel = topLevelId(snapshot, product);
  const sameTop = others.filter((p) => p.categoryId !== product.categoryId && topLevelId(snapshot, p) === topLevel);
  return [...leaf, ...closest(sameTop)];
}

/**
 * Shares a room, different top-level category. One per category in category order, then a second per
 * category, … Inside a category: a shared color first, then the lowest price.
 */
function autoGoesWith(snapshot: CatalogSnapshot, product: SnapshotProduct): SnapshotProduct[] {
  const topLevel = topLevelId(snapshot, product);
  const colors = colorsOf(product);
  const groups = new Map<number, SnapshotProduct[]>();
  for (const p of snapshot.products) {
    const top = topLevelId(snapshot, p);
    if (p.id === product.id || top === topLevel || ![...p.roomSlugs].some((r) => product.roomSlugs.has(r))) continue;
    const group = groups.get(top);
    if (group) group.push(p);
    else groups.set(top, [p]);
  }

  const sharesColor = (p: SnapshotProduct) => [...colorsOf(p)].some((c) => colors.has(c));
  const ordered = [...groups.entries()]
    .sort(([a], [b]) => {
      const ca = snapshot.categoriesById.get(a)!;
      const cb = snapshot.categoriesById.get(b)!;
      return ca.sortOrder - cb.sortOrder || ca.id - cb.id;
    })
    .map(([, products]) =>
      products
        .map((p) => ({ p, shared: sharesColor(p) ? 0 : 1, price: cheapest(p).price }))
        .sort((a, b) => a.shared - b.shared || a.price - b.price || a.p.id - b.p.id)
        .map(({ p }) => p),
    );

  const result: SnapshotProduct[] = [];
  for (let round = 0; ordered.some((g) => g.length > round); round++) {
    for (const group of ordered) if (group[round]) result.push(group[round]);
  }
  return result;
}

function topLevelId(snapshot: CatalogSnapshot, p: SnapshotProduct): number {
  return snapshot.categoriesById.get(p.categoryId)!.pathIds[0]!;
}

/** Lowest-priced active variant (ties: the first in variant order). */
function cheapest(p: SnapshotProduct): SnapshotVariant {
  return p.variants.reduce((best, v) => (v.price < best.price ? v : best));
}

/** Color value codes of the product's variants and product-level color attribute. */
function colorsOf(p: SnapshotProduct): Set<string> {
  const colors = new Set(p.attributes.get('color') ?? []);
  for (const v of p.variants) {
    const color = v.options.get('color');
    if (color) colors.add(color);
  }
  return colors;
}
