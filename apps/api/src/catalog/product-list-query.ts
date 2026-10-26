import { BadRequestException } from '@nestjs/common';
import { PRODUCT_SORTS, type FulfillmentMode, type ProductListQuery, type ProductSort } from '@hg/models';
import { MAX_PAGE_SIZE } from './product-query.js';

const FULFILLMENT_MODES: FulfillmentMode[] = ['in_stock', 'pre_order', 'made_to_order', 'out_of_stock'];
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CODE = /^[a-z0-9-]+$/;
const ATTR_PREFIX = 'attr.';
const MAX_Q_LENGTH = 100;

/**
 * Parses the query string of GET /api/products (kept in the URL by the storefront, CAT-08):
 *   ?category=sofas&room=living-room&q=ספה&minPrice=100000&maxWidth=300
 *   &fulfillment=in_stock,pre_order&attr.color=beige,gray&sort=price_asc&page=2&pageSize=24
 * Prices are agorot, sizes cm. Unknown attribute codes are ignored; malformed values are a 400.
 */
export function parseProductListQuery(raw: Record<string, unknown>): ProductListQuery {
  const query: ProductListQuery = {};

  const category = text(raw, 'category');
  if (category !== undefined) query.category = slug(category, 'category');
  const room = text(raw, 'room');
  if (room !== undefined) query.room = slug(room, 'room');

  const q = text(raw, 'q')?.trim();
  if (q) {
    if (q.length > MAX_Q_LENGTH) throw new BadRequestException(`q is longer than ${MAX_Q_LENGTH} characters`);
    query.q = q;
  }

  for (const key of ['minPrice', 'maxPrice', 'minWidth', 'maxWidth', 'minDepth', 'maxDepth'] as const) {
    const value = text(raw, key);
    if (value !== undefined) query[key] = number(value, key, 0);
  }

  const fulfillment = list(raw, 'fulfillment');
  if (fulfillment) {
    for (const mode of fulfillment) {
      if (!FULFILLMENT_MODES.includes(mode as FulfillmentMode))
        throw new BadRequestException(`unknown fulfillment "${mode}"`);
    }
    query.fulfillment = fulfillment as FulfillmentMode[];
  }

  for (const key of Object.keys(raw)) {
    if (!key.startsWith(ATTR_PREFIX)) continue;
    const code = key.slice(ATTR_PREFIX.length);
    const values = list(raw, key);
    if (!CODE.test(code) || !values?.every((v) => CODE.test(v))) throw new BadRequestException(`invalid filter ${key}`);
    (query.attributes ??= {})[code] = values;
  }

  const sort = text(raw, 'sort');
  if (sort !== undefined) {
    if (!PRODUCT_SORTS.includes(sort as ProductSort)) throw new BadRequestException(`unknown sort "${sort}"`);
    query.sort = sort as ProductSort;
  }

  const page = text(raw, 'page');
  if (page !== undefined) query.page = integer(page, 'page', 1);
  const pageSize = text(raw, 'pageSize');
  if (pageSize !== undefined) query.pageSize = Math.min(integer(pageSize, 'pageSize', 1), MAX_PAGE_SIZE);

  return query;
}

function text(raw: Record<string, unknown>, key: string): string | undefined {
  const value = raw[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new BadRequestException(`${key} must appear once`);
  return value;
}

function list(raw: Record<string, unknown>, key: string): string[] | undefined {
  const value = text(raw, key);
  if (value === undefined) return undefined;
  const items = value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
  return items.length ? items : undefined;
}

function slug(value: string, key: string): string {
  if (!SLUG.test(value)) throw new BadRequestException(`invalid ${key}`);
  return value;
}

function number(value: string, key: string, min: number): number {
  const n = Number(value);
  if (value.trim() === '' || !Number.isFinite(n) || n < min)
    throw new BadRequestException(`${key} must be a number ≥ ${min}`);
  return n;
}

function integer(value: string, key: string, min: number): number {
  const n = number(value, key, min);
  if (!Number.isInteger(n)) throw new BadRequestException(`${key} must be an integer`);
  return n;
}
