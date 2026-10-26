import { Injectable } from '@nestjs/common';
import type {
  CategoryNode,
  ProductDetail,
  ProductListQuery,
  ProductListResponse,
  RoomMenuItem,
  SearchSuggestions,
} from '@hg/models';
import { CacheStore } from '../cache/cache-store.js';
import type { CatalogSnapshot, SnapshotCategory } from './catalog-snapshot.js';
import { CatalogRepository } from './catalog.repository.js';
import { queryProducts } from './product-query.js';
import { SearchProvider } from './search/search-provider.js';
import { normalizeSearchText, tokenizeQuery } from './search/search-text.js';

/** Catalog read model TTL. Admin changes (Phase 2) will also invalidate the `catalog:` prefix. */
export const CATALOG_TTL_MS = 60_000;
const SUGGEST_PRODUCTS = 6;
const SUGGEST_CATEGORIES = 4;

@Injectable()
export class CatalogService {
  constructor(
    private readonly repository: CatalogRepository,
    private readonly search: SearchProvider,
    private readonly cache: CacheStore,
  ) {}

  snapshot(): Promise<CatalogSnapshot> {
    return this.cache.wrap('catalog:snapshot', CATALOG_TTL_MS, () => this.repository.loadSnapshot());
  }

  /** Category tree, limited to categories that have active products. */
  async categories(): Promise<CategoryNode[]> {
    const snapshot = await this.snapshot();
    const withProducts = categoriesWithProducts(snapshot);
    const toNode = (c: SnapshotCategory): CategoryNode => ({
      slug: c.slug,
      nameHe: c.nameHe,
      children: childrenOf(snapshot, c.id)
        .filter((child) => withProducts.has(child.id))
        .map(toNode),
    });
    return childrenOf(snapshot, null)
      .filter((c) => withProducts.has(c.id))
      .map(toNode);
  }

  /** Main menu (decision 44): rooms with products, each with its top-level furniture types. */
  async rooms(): Promise<RoomMenuItem[]> {
    const snapshot = await this.snapshot();
    return [...snapshot.rooms.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((room) => {
        const topLevelIds = new Set(
          snapshot.products
            .filter((p) => p.roomSlugs.has(room.slug))
            .map((p) => snapshot.categoriesById.get(p.categoryId)!.pathIds[0]),
        );
        const categories = [...topLevelIds]
          .map((id) => snapshot.categoriesById.get(id)!)
          .sort(bySortOrder)
          .map((c) => ({ slug: c.slug, nameHe: c.nameHe }));
        return { slug: room.slug, nameHe: room.nameHe, categories };
      })
      .filter((room) => room.categories.length > 0);
  }

  async products(query: ProductListQuery): Promise<ProductListResponse> {
    const snapshot = await this.snapshot();
    const searchScores = query.q ? await this.search.search(query.q) : undefined;
    return queryProducts(snapshot, query, { searchScores, now: new Date() });
  }

  async product(slug: string): Promise<ProductDetail | null> {
    return this.repository.findProductDetail(slug, await this.snapshot());
  }

  /** Autocomplete (SRC-01): best products and matching category names. */
  async suggest(q: string): Promise<SearchSuggestions> {
    const terms = tokenizeQuery(q);
    if (terms.length === 0) return { products: [], categories: [] };

    const [snapshot, scores] = await Promise.all([this.snapshot(), this.search.search(q)]);
    const { items } = queryProducts(
      snapshot,
      { pageSize: SUGGEST_PRODUCTS },
      { searchScores: scores, now: new Date() },
    );

    const withProducts = categoriesWithProducts(snapshot);
    const categories = [...snapshot.categoriesById.values()]
      .filter((c) => withProducts.has(c.id))
      .filter((c) => {
        const name = normalizeSearchText(c.nameHe);
        return terms.every((t) => name.includes(t)) || name.includes(normalizeSearchText(q));
      })
      .sort(bySortOrder)
      .slice(0, SUGGEST_CATEGORIES)
      .map((c) => ({ slug: c.slug, nameHe: c.nameHe }));

    return {
      products: items.map(({ slug, modelName, nameHe, priceFrom, image }) => ({
        slug,
        modelName,
        nameHe,
        priceFrom,
        image,
      })),
      categories,
    };
  }
}

function categoriesWithProducts(snapshot: CatalogSnapshot): Set<number> {
  const ids = new Set<number>();
  for (const p of snapshot.products) {
    for (const id of snapshot.categoriesById.get(p.categoryId)?.pathIds ?? []) ids.add(id);
  }
  return ids;
}

function childrenOf(snapshot: CatalogSnapshot, parentId: number | null): SnapshotCategory[] {
  return [...snapshot.categoriesById.values()].filter((c) => c.parentId === parentId).sort(bySortOrder);
}

function bySortOrder(a: SnapshotCategory, b: SnapshotCategory): number {
  return a.sortOrder - b.sortOrder || a.id - b.id;
}
