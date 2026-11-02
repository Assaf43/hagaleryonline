/**
 * Catalog management in the admin (Phase 2b), shared by the API and the admin app.
 * Money is in agorot (VAT included); the admin shows and accepts shekels. Dimensions in cm.
 */
import type { Dimensions, FulfillmentMode } from './catalog.js';

// ---------- Structure: categories, rooms, closed value lists, synonyms ----------

export interface AdminCategory {
  id: number;
  slug: string;
  nameHe: string;
  parentId: number | null;
  sortOrder: number;
  active: boolean;
  /** Attributes this category filters by and offers as variant options, in order. */
  attributeCodes: string[];
  productCount: number;
}

export interface AdminCategoryInput {
  slug: string;
  nameHe: string;
  parentId: number | null;
  sortOrder: number;
  active: boolean;
  attributeCodes: string[];
}

export interface AdminRoom {
  id: number;
  slug: string;
  nameHe: string;
  sortOrder: number;
  active: boolean;
  productCount: number;
}

export type AdminRoomInput = Omit<AdminRoom, 'id' | 'productCount'>;

export type AttributeScope = 'product' | 'variant';

export interface AdminAttributeValue {
  id: number;
  code: string;
  labelHe: string;
  swatchHex: string | null;
  sortOrder: number;
  /** Products and variants that use this value; a used value cannot be deleted. */
  usageCount: number;
}

export type AdminAttributeValueInput = Omit<AdminAttributeValue, 'id' | 'usageCount'>;

export interface AdminAttribute {
  id: number;
  code: string;
  nameHe: string;
  /** Chosen once per product (style) or per variant (color, fabric). Fixed after creation. */
  scope: AttributeScope;
  filterable: boolean;
  sortOrder: number;
  values: AdminAttributeValue[];
}

export type AdminAttributeInput = Omit<AdminAttribute, 'id' | 'values'>;

export interface AdminSynonym {
  id: number;
  terms: string[];
}

/** GET /api/admin/catalog/structure */
export interface CatalogStructure {
  categories: AdminCategory[];
  rooms: AdminRoom[];
  attributes: AdminAttribute[];
  synonyms: AdminSynonym[];
}

// ---------- Products ----------

export type ProductStatusFilter = 'all' | 'active' | 'hidden';

export interface AdminProductRow {
  id: number;
  slug: string;
  modelName: string;
  nameHe: string;
  categoryId: number;
  active: boolean;
  variantCount: number;
  /** Lowest price of the active variants, agorot. */
  priceFrom: number | null;
  totalStock: number;
  updatedAt: string;
}

/** GET /api/admin/catalog/products?q=&categoryId=&status=&page= */
export interface AdminProductPage {
  items: AdminProductRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface AdminVariant extends Dimensions {
  /** Missing for a variant that is not saved yet. */
  id?: number;
  sku: string;
  price: number;
  compareAtPrice: number | null;
  stock: number;
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
  productionDays: number | null;
  /** YYYY-MM-DD */
  expectedAt: string | null;
  active: boolean;
  /** Variant attribute code → value code, e.g. { color: 'beige', fabric: 'boucle' }. */
  options: Record<string, string>;
}

export interface AdminProductInput {
  slug: string;
  /** English, unique (decision 46). Stored upper-case. */
  modelName: string;
  nameHe: string;
  /** Sanitized HTML: paragraphs, headings, bold, italic, lists and links only. */
  descriptionHe: string;
  categoryId: number;
  roomIds: number[];
  /** Product attribute code → value codes, e.g. { style: ['modern'] }. */
  attributes: Record<string, string[]>;
  countryOfOrigin: string | null;
  warrantyMonths: number | null;
  careHe: string | null;
  requiresAssembly: boolean;
  active: boolean;
  sortOrder: number;
  variants: AdminVariant[];
  /** The updatedAt the editor started from; a newer save by someone else is a conflict. */
  expectedUpdatedAt?: string;
}

export interface AdminProduct extends Omit<AdminProductInput, 'expectedUpdatedAt'> {
  id: number;
  createdAt: string;
  updatedAt: string;
}

// ---------- Errors ----------

/**
 * Error codes of the catalog endpoints. `field` names what is wrong (e.g. "sku", "variants.3.price"),
 * `value` the offending value where it helps (a duplicate SKU).
 */
export type CatalogErrorCode =
  /** Someone else saved this product after it was opened. */
  | 'conflict'
  | 'duplicate'
  | 'invalid'
  /** A value or category still in use cannot be removed. */
  | 'in_use'
  /** Cannot show the product on the site yet: `reasons` lists what is missing. */
  | 'incomplete'
  | 'not_found';

/** Why a product cannot be shown yet: no active variant, or its category is hidden. */
export type ActivationProblem = 'no_variants' | 'category_hidden';

/** Hebrew names of the fulfillment modes, used by the admin and the Excel template. */
export const FULFILLMENT_LABELS_HE: Record<FulfillmentMode, string> = {
  in_stock: 'במלאי',
  pre_order: 'בהזמנה מוקדמת',
  made_to_order: 'בייצור לפי הזמנה',
  out_of_stock: 'אזל',
};

// ---------- Excel import and export (Phase 2c, ADM-09) ----------

export type ImportIssueCode =
  /** The file is not an .xlsx this system made, or has no products sheet. */
  | 'bad_file'
  | 'missing_column'
  | 'no_rows'
  | 'too_many_rows'
  | 'required'
  | 'number'
  | 'date'
  | 'yes_no'
  | 'not_in_list'
  /** Rows of the same model disagree on a product-level column (e.g. two categories). */
  | 'mixed_values'
  /** The SKU appears twice in the file. */
  | 'duplicate_sku'
  /** The SKU belongs to another model. */
  | 'sku_taken'
  /** Refused when saving: `catalogCode` says why (same codes as the product form). */
  | 'rejected';

export interface ImportIssue {
  /** Excel row number, as the user sees it. Null for problems with the whole file. */
  row: number | null;
  /** Column header, as in the file. */
  column: string | null;
  code: ImportIssueCode;
  value?: string;
  catalogCode?: CatalogErrorCode;
}

export interface ImportSummary {
  rows: number;
  productsCreated: number;
  productsUpdated: number;
  productsUnchanged: number;
  variantsCreated: number;
  variantsUpdated: number;
  priceChanges: number;
}

/** POST /api/admin/catalog/excel/check and /import. Nothing is saved unless `applied`. */
export interface ImportReport {
  applied: boolean;
  errors: ImportIssue[];
  summary: ImportSummary;
}
