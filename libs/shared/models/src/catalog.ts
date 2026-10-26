/**
 * Catalog API contracts, shared by the API, the storefront and the admin.
 *
 * Money is in agorot (integer, VAT included) — format with `/ 100` on display.
 * Dimensions are numbers in cm.
 */

export type FulfillmentMode = 'in_stock' | 'pre_order' | 'made_to_order' | 'out_of_stock';

export type ProductSort = 'recommended' | 'bestsellers' | 'price_asc' | 'price_desc' | 'newest';

export const PRODUCT_SORTS: readonly ProductSort[] = [
  'recommended',
  'bestsellers',
  'price_asc',
  'price_desc',
  'newest',
];

export interface ImageRef {
  url: string;
  altHe: string;
}

// ---------- Navigation ----------

/** GET /api/categories */
export interface CategoryNode {
  slug: string;
  nameHe: string;
  children: CategoryNode[];
}

/** GET /api/rooms — only rooms and categories that have active products (decision 44). */
export interface RoomMenuItem {
  slug: string;
  nameHe: string;
  categories: { slug: string; nameHe: string }[];
}

// ---------- Product list ----------

/** Query of GET /api/products. Every filter is optional; attribute filters are `attr.<code>=v1,v2`. */
export interface ProductListQuery {
  category?: string;
  room?: string;
  q?: string;
  minPrice?: number;
  maxPrice?: number;
  minWidth?: number;
  maxWidth?: number;
  minDepth?: number;
  maxDepth?: number;
  fulfillment?: FulfillmentMode[];
  attributes?: Record<string, string[]>;
  sort?: ProductSort;
  page?: number;
  pageSize?: number;
}

export interface Swatch {
  code: string;
  labelHe: string;
  hex: string | null;
}

export interface ProductCard {
  slug: string;
  modelName: string;
  nameHe: string;
  /** Lowest price among the variants that match the filters. */
  priceFrom: number;
  /** compare-at price of that same variant, when on sale. */
  compareAtFrom: number | null;
  discountPercent: number | null;
  /** True when variants differ in price ("החל מ"). */
  hasPriceRange: boolean;
  swatches: Swatch[];
  image: ImageRef | null;
  /** Fastest delivery among matching variants. */
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
  isNew: boolean;
}

export interface FacetValue {
  code: string;
  labelHe: string;
  hex: string | null;
  count: number;
  selected: boolean;
}

/** One filter group. Counts follow the other active filters, not this one (CAT-05). */
export interface Facet {
  code: string;
  nameHe: string;
  values: FacetValue[];
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface ProductListResponse {
  items: ProductCard[];
  total: number;
  page: number;
  pageSize: number;
  facets: Facet[];
  fulfillment: { mode: FulfillmentMode; count: number; selected: boolean }[];
  /** Bounds for the range sliders (CAT-04); null when nothing matches. */
  ranges: { price: NumericRange | null; width: NumericRange | null; depth: NumericRange | null };
}

// ---------- Product page ----------

export interface Dimensions {
  widthCm: number;
  depthCm: number;
  heightCm: number;
  weightKg: number | null;
  seatHeightCm: number | null;
  seatDepthCm: number | null;
  chaiseWidthCm: number | null;
  chaiseDepthCm: number | null;
}

export interface VariantDetail {
  sku: string;
  price: number;
  compareAtPrice: number | null;
  inStock: boolean;
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
  productionDays: number | null;
  /** ISO date (YYYY-MM-DD), for pre-order. */
  expectedAt: string | null;
  dimensions: Dimensions;
  /** attribute code → value code, e.g. { color: 'beige', 'chaise-side': 'right' } */
  options: Record<string, string>;
  images: ImageRef[];
}

/** A variant selector on the product page (PRD-04): color, fabric, chaise side... */
export interface OptionAxis {
  code: string;
  nameHe: string;
  values: { code: string; labelHe: string; hex: string | null }[];
}

/** GET /api/products/:slug */
export interface ProductDetail {
  slug: string;
  modelName: string;
  nameHe: string;
  descriptionHe: string;
  breadcrumbs: { slug: string; nameHe: string }[];
  rooms: { slug: string; nameHe: string }[];
  /** Product-level attributes (style, structure...) as display rows. */
  specs: { code: string; nameHe: string; valuesHe: string[] }[];
  countryOfOrigin: string | null;
  warrantyMonths: number | null;
  careHe: string | null;
  requiresAssembly: boolean;
  images: ImageRef[];
  optionAxes: OptionAxis[];
  variants: VariantDetail[];
}

// ---------- Search ----------

/** GET /api/search/suggest?q= (SRC-01) */
export interface SearchSuggestions {
  products: { slug: string; modelName: string; nameHe: string; priceFrom: number; image: ImageRef | null }[];
  categories: { slug: string; nameHe: string }[];
}
