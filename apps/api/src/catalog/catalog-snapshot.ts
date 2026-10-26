import type { FulfillmentMode, ImageRef } from '@hg/models';

/**
 * Read model of the whole active catalog, loaded once and cached (CatalogRepository).
 * Filtering, facets and sorting run on it in memory (product-query.ts): with a catalog of
 * hundreds to a few thousand products this is fast, simple and exact (disjunctive facets).
 * If the catalog grows far beyond that, move the query to SQL or a search engine behind the same service.
 */
export interface CatalogSnapshot {
  products: SnapshotProduct[];
  categories: Map<string, SnapshotCategory>;
  categoriesById: Map<number, SnapshotCategory>;
  attributes: Map<string, SnapshotAttribute>;
  rooms: Map<string, { id: number; slug: string; nameHe: string; sortOrder: number }>;
}

export interface SnapshotCategory {
  id: number;
  slug: string;
  nameHe: string;
  parentId: number | null;
  sortOrder: number;
  /** This category and every category below it. */
  descendantIds: Set<number>;
  /** This category and every category above it, root first. */
  pathIds: number[];
  /** Attribute codes linked to this category (not inherited). */
  attributeCodes: string[];
}

export interface SnapshotAttribute {
  code: string;
  nameHe: string;
  scope: 'product' | 'variant';
  filterable: boolean;
  sortOrder: number;
  values: Map<string, { code: string; labelHe: string; hex: string | null; sortOrder: number }>;
}

export interface SnapshotVariant {
  id: number;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
  sortOrder: number;
  widthCm: number;
  depthCm: number;
  /** attribute code → value code (one value per variant attribute). */
  options: Map<string, string>;
}

export interface SnapshotProduct {
  id: number;
  slug: string;
  modelName: string;
  nameHe: string;
  categoryId: number;
  roomSlugs: Set<string>;
  sortOrder: number;
  popularity: number;
  createdAt: Date;
  /** Product-level attribute code → value codes. */
  attributes: Map<string, Set<string>>;
  /** Active variants only; products without any are left out of the snapshot. */
  variants: SnapshotVariant[];
  image: ImageRef | null;
}
