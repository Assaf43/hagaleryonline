import type {
  AdminAttributeInput,
  AdminAttributeValueInput,
  AdminCategoryInput,
  AdminImageInput,
  AdminProductInput,
  AdminRoomInput,
  AdminVariant,
  FulfillmentMode,
  ImageKindCode,
} from '@hg/models';
import { invalid } from './catalog-errors.js';
import { sanitizeDescription } from '../catalog/description-html.js';

/**
 * Request-body checks for the catalog endpoints. Each parser returns a clean, normalized value or
 * throws `invalid(field)`, so the admin can point at the exact field (e.g. "variants.2.price").
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MODEL_NAME = /^[A-Z0-9][A-Z0-9 -]*$/;
const SKU = /^[A-Z0-9][A-Z0-9-]*$/;
const HEX = /^#[0-9a-f]{6}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FULFILLMENT: readonly FulfillmentMode[] = ['in_stock', 'pre_order', 'made_to_order', 'out_of_stock'];
/** ₪1,000,000 in agorot — far above any piece of furniture, catches a mistyped price. */
const MAX_PRICE = 100_000_000;
const MAX_CM = 10_000;
const MAX_VARIANTS = 500;

type Body = Record<string, unknown>;

function obj(value: unknown, field: string): Body {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw invalid(field);
  return value as Body;
}

function text(body: Body, key: string, field = key, max = 200): string {
  const value = body[key];
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max) throw invalid(field);
  return value.trim();
}

function optionalText(body: Body, key: string, field = key, max = 2000): string | null {
  const value = body[key];
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > max) throw invalid(field);
  return value.trim() || null;
}

function int(body: Body, key: string, field = key, min = 0, max = 1_000_000_000): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw invalid(field);
  return value;
}

function optionalInt(body: Body, key: string, field = key, min = 0, max = 1_000_000_000): number | null {
  return body[key] === undefined || body[key] === null ? null : int(body, key, field, min, max);
}

function flag(body: Body, key: string, field = key): boolean {
  const value = body[key];
  if (typeof value !== 'boolean') throw invalid(field);
  return value;
}

/** Centimetres with one decimal, as stored (Decimal(6,1)). */
function cm(body: Body, key: string, field: string): number {
  const value = body[key];
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > MAX_CM) throw invalid(field);
  return Math.round(value * 10) / 10;
}

function optionalCm(body: Body, key: string, field: string): number | null {
  return body[key] === undefined || body[key] === null ? null : cm(body, key, field);
}

function slug(body: Body, key = 'slug'): string {
  const value = text(body, key, key, 120).toLowerCase();
  if (!SLUG.test(value)) throw invalid(key);
  return value;
}

/** English code of a closed-list value or attribute: lower-case letters, digits and hyphens. */
export function code(body: Body, key = 'code'): string {
  const value = text(body, key, key, 60).toLowerCase();
  if (!SLUG.test(value)) throw invalid(key);
  return value;
}

function ids(value: unknown, field: string): number[] {
  if (!Array.isArray(value) || value.some((v) => !Number.isInteger(v) || (v as number) < 1)) throw invalid(field);
  return [...new Set(value as number[])];
}

function codes(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !SLUG.test(v))) throw invalid(field);
  return [...new Set(value as string[])];
}

export function parseVariant(raw: unknown, index: number): AdminVariant {
  const at = (key: string) => `variants.${index}.${key}`;
  const body = obj(raw, `variants.${index}`);
  const sku = text(body, 'sku', at('sku'), 60).toUpperCase();
  if (!SKU.test(sku)) throw invalid(at('sku'));

  const price = int(body, 'price', at('price'), 1, MAX_PRICE);
  const compareAtPrice = optionalInt(body, 'compareAtPrice', at('compareAtPrice'), 1, MAX_PRICE);
  // A "before" price lower than the price would show a fake discount.
  if (compareAtPrice !== null && compareAtPrice <= price) throw invalid(at('compareAtPrice'));

  const fulfillment = body['fulfillment'] as FulfillmentMode;
  if (!FULFILLMENT.includes(fulfillment)) throw invalid(at('fulfillment'));
  const expectedAt = optionalText(body, 'expectedAt', at('expectedAt'), 10);
  if (expectedAt !== null && (!DATE.test(expectedAt) || Number.isNaN(Date.parse(expectedAt))))
    throw invalid(at('expectedAt'));

  const options = obj(body['options'] ?? {}, at('options'));
  for (const [attribute, value] of Object.entries(options)) {
    if (!SLUG.test(attribute) || typeof value !== 'string' || !SLUG.test(value)) throw invalid(at('options'));
  }

  return {
    ...(body['id'] === undefined || body['id'] === null ? {} : { id: int(body, 'id', at('id'), 1) }),
    sku,
    price,
    compareAtPrice,
    stock: int(body, 'stock', at('stock'), 0, 100_000),
    fulfillment,
    leadTimeDays: int(body, 'leadTimeDays', at('leadTimeDays'), 0, 365),
    productionDays: optionalInt(body, 'productionDays', at('productionDays'), 0, 365),
    expectedAt,
    active: flag(body, 'active', at('active')),
    widthCm: cm(body, 'widthCm', at('widthCm')),
    depthCm: cm(body, 'depthCm', at('depthCm')),
    heightCm: cm(body, 'heightCm', at('heightCm')),
    weightKg: optionalCm(body, 'weightKg', at('weightKg')),
    seatHeightCm: optionalCm(body, 'seatHeightCm', at('seatHeightCm')),
    seatDepthCm: optionalCm(body, 'seatDepthCm', at('seatDepthCm')),
    chaiseWidthCm: optionalCm(body, 'chaiseWidthCm', at('chaiseWidthCm')),
    chaiseDepthCm: optionalCm(body, 'chaiseDepthCm', at('chaiseDepthCm')),
    options: options as Record<string, string>,
  };
}

export function parseProductInput(raw: unknown): AdminProductInput {
  const body = obj(raw, 'body');
  const modelName = text(body, 'modelName', 'modelName', 40).toUpperCase().replace(/\s+/g, ' ');
  if (!MODEL_NAME.test(modelName)) throw invalid('modelName');

  const attributes = obj(body['attributes'] ?? {}, 'attributes');
  const parsedAttributes: Record<string, string[]> = {};
  for (const [attribute, values] of Object.entries(attributes)) {
    if (!SLUG.test(attribute)) throw invalid('attributes');
    const list = codes(values, 'attributes');
    if (list.length) parsedAttributes[attribute] = list;
  }

  if (!Array.isArray(body['variants']) || body['variants'].length > MAX_VARIANTS) throw invalid('variants');
  const variants = body['variants'].map((v, i) => parseVariant(v, i));
  const seen = new Set<string>();
  variants.forEach((v, i) => {
    if (seen.has(v.sku)) throw invalid(`variants.${i}.sku`);
    seen.add(v.sku);
  });

  const description = body['descriptionHe'];
  if (typeof description !== 'string' || description.length > 20_000) throw invalid('descriptionHe');
  const expectedUpdatedAt = optionalText(body, 'expectedUpdatedAt', 'expectedUpdatedAt', 40);

  return {
    slug: slug(body),
    modelName,
    nameHe: text(body, 'nameHe', 'nameHe', 150),
    descriptionHe: sanitizeDescription(description),
    categoryId: int(body, 'categoryId', 'categoryId', 1),
    roomIds: ids(body['roomIds'] ?? [], 'roomIds'),
    attributes: parsedAttributes,
    countryOfOrigin: optionalText(body, 'countryOfOrigin', 'countryOfOrigin', 60),
    warrantyMonths: optionalInt(body, 'warrantyMonths', 'warrantyMonths', 0, 240),
    careHe: optionalText(body, 'careHe'),
    requiresAssembly: flag(body, 'requiresAssembly'),
    active: flag(body, 'active'),
    sortOrder: int(body, 'sortOrder', 'sortOrder', 0, 1_000_000),
    variants,
    ...(expectedUpdatedAt ? { expectedUpdatedAt } : {}),
  };
}

export function parseCategoryInput(raw: unknown): AdminCategoryInput {
  const body = obj(raw, 'body');
  return {
    slug: slug(body),
    nameHe: text(body, 'nameHe', 'nameHe', 80),
    parentId: optionalInt(body, 'parentId', 'parentId', 1),
    sortOrder: int(body, 'sortOrder', 'sortOrder', 0, 10_000),
    active: flag(body, 'active'),
    attributeCodes: codes(body['attributeCodes'] ?? [], 'attributeCodes'),
  };
}

export function parseRoomInput(raw: unknown): AdminRoomInput {
  const body = obj(raw, 'body');
  return {
    slug: slug(body),
    nameHe: text(body, 'nameHe', 'nameHe', 80),
    sortOrder: int(body, 'sortOrder', 'sortOrder', 0, 10_000),
    active: flag(body, 'active'),
  };
}

export function parseAttributeInput(raw: unknown): AdminAttributeInput {
  const body = obj(raw, 'body');
  const scope = body['scope'];
  if (scope !== 'product' && scope !== 'variant') throw invalid('scope');
  return {
    code: code(body),
    nameHe: text(body, 'nameHe', 'nameHe', 80),
    scope,
    filterable: flag(body, 'filterable'),
    sortOrder: int(body, 'sortOrder', 'sortOrder', 0, 10_000),
  };
}

export function parseAttributeValueInput(raw: unknown): AdminAttributeValueInput {
  const body = obj(raw, 'body');
  const swatchHex = optionalText(body, 'swatchHex', 'swatchHex', 7)?.toLowerCase() ?? null;
  if (swatchHex !== null && !HEX.test(swatchHex)) throw invalid('swatchHex');
  return {
    code: code(body),
    labelHe: text(body, 'labelHe', 'labelHe', 80),
    swatchHex,
    sortOrder: int(body, 'sortOrder', 'sortOrder', 0, 10_000),
  };
}

/** A synonym group: at least two different words (decision 47). */
export function parseSynonymTerms(raw: unknown): string[] {
  const value = obj(raw, 'body')['terms'];
  if (!Array.isArray(value)) throw invalid('terms');
  const terms = [
    ...new Set(
      value.map((t) => {
        if (typeof t !== 'string' || t.trim().length === 0 || t.length > 60) throw invalid('terms');
        return t.trim().replace(/\s+/g, ' ');
      }),
    ),
  ];
  if (terms.length < 2 || terms.length > 20) throw invalid('terms');
  return terms;
}

/** Fields whose value changed, for the audit log: only those go into before/after. */
export function changedFields(
  before: object,
  after: object,
): { before: Record<string, unknown>; after: Record<string, unknown> } | null {
  const previous = before as Record<string, unknown>;
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(after)) {
    if (JSON.stringify(previous[key]) !== JSON.stringify(value)) {
      b[key] = previous[key];
      a[key] = value;
    }
  }
  return Object.keys(a).length ? { before: b, after: a } : null;
}

const IMAGE_KINDS: readonly ImageKindCode[] = ['cutout', 'lifestyle'];
const VALUE_CODE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * A photo's details. On upload (multipart form fields) every field is optional and `altHe` may be
 * empty — the product name and color fill it in; on edit all are required.
 */
export function parseImageInput(raw: unknown, partial: true): Partial<AdminImageInput>;
export function parseImageInput(raw: unknown, partial?: false): AdminImageInput;
export function parseImageInput(raw: unknown, partial = false): Partial<AdminImageInput> {
  const body = obj(raw ?? {}, 'body');
  const result: Partial<AdminImageInput> = {};
  const color = body['colorCode'];
  if (color === null || color === '') result.colorCode = null;
  else if (typeof color === 'string' && color.length <= 60 && VALUE_CODE.test(color)) result.colorCode = color;
  else if (color !== undefined || !partial) throw invalid('colorCode');

  const kind = body['kind'];
  if (IMAGE_KINDS.includes(kind as ImageKindCode)) result.kind = kind as ImageKindCode;
  else if (kind !== undefined || !partial) throw invalid('kind');

  if (partial) {
    const alt = optionalText(body, 'altHe', 'altHe', 200);
    if (alt) result.altHe = alt;
  } else {
    result.altHe = text(body, 'altHe', 'altHe', 200);
  }
  return result;
}

/** PUT …/images/order: every photo id of the product, in the new order. */
export function parseImageOrder(raw: unknown): number[] {
  const ids = obj(raw, 'body')['ids'];
  if (
    !Array.isArray(ids) ||
    ids.length > 100 ||
    ids.some((i) => typeof i !== 'number' || !Number.isInteger(i) || i < 1)
  )
    throw invalid('ids');
  return ids as number[];
}
