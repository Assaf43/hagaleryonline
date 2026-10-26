/**
 * Development seed: `npm run db:seed` (wipes and refills the catalog). Never runs in production.
 */
import { config } from 'dotenv';
import { PrismaPg } from '@prisma/adapter-pg';
import { AttributeScope, FulfillmentMode, ImageKind, PrismaClient } from '../src/generated/prisma/client.js';
import { buildProductSearchText } from '../src/catalog/search/search-text.js';
import {
  ATTRIBUTES,
  CARE_HE,
  CATEGORIES,
  PRODUCTS,
  ROOMS,
  SYNONYMS,
  type CategorySeed,
  type ProductSeed,
} from './seed-data.js';

config({ path: '../../.env', quiet: true });

if (process.env.NODE_ENV === 'production') {
  throw new Error('The seed wipes the catalog and must not run in production.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL! }) });

const FULFILLMENT: Record<ProductSeed['delivery']['mode'], FulfillmentMode> = {
  in_stock: FulfillmentMode.IN_STOCK,
  pre_order: FulfillmentMode.PRE_ORDER,
  made_to_order: FulfillmentMode.MADE_TO_ORDER,
  out_of_stock: FulfillmentMode.OUT_OF_STOCK,
};
/** Fabric surcharge over the base price. */
const FABRIC_PREMIUM: Record<string, number> = {
  boucle: 0.1,
  velvet: 0.08,
  chenille: 0.06,
  corduroy: 0.06,
  leather: 0.4,
};
const SKU_CODE: Record<string, string> = {
  'off-white': 'OW',
  cream: 'CR',
  beige: 'BG',
  sand: 'SD',
  'light-gray': 'LG',
  gray: 'GR',
  'dark-gray': 'DG',
  olive: 'OL',
  navy: 'NV',
  terracotta: 'TC',
  brown: 'BR',
  'natural-oak': 'OK',
  walnut: 'WN',
  black: 'BK',
  white: 'WH',
  woven: 'WV',
  boucle: 'BC',
  velvet: 'VL',
  chenille: 'CH',
  corduroy: 'CD',
  'faux-leather': 'FL',
  leather: 'LT',
  right: 'R',
  left: 'L',
  reversible: 'RV',
};
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  await prisma.$executeRawUnsafe(
    'TRUNCATE products, categories, rooms, attributes, search_synonyms RESTART IDENTITY CASCADE',
  );

  // Attributes and their closed value lists (ADM-03).
  const valueIds = new Map<string, number>(); // "code:value" → id
  const valueLabels = new Map<number, string>();
  for (const [index, a] of ATTRIBUTES.entries()) {
    const attribute = await prisma.attribute.create({
      data: {
        code: a.code,
        nameHe: a.nameHe,
        scope: a.scope === 'product' ? AttributeScope.PRODUCT : AttributeScope.VARIANT,
        filterable: a.filterable ?? true,
        sortOrder: index,
        values: {
          create: a.values.map(([code, labelHe, hex], i) => ({ code, labelHe, swatchHex: hex ?? null, sortOrder: i })),
        },
      },
      include: { values: true },
    });
    for (const v of attribute.values) {
      valueIds.set(`${a.code}:${v.code}`, v.id);
      valueLabels.set(v.id, v.labelHe);
    }
  }
  const attributeIds = new Map((await prisma.attribute.findMany()).map((a) => [a.code, a.id]));
  const valueId = (code: string, value: string) => {
    const id = valueIds.get(`${code}:${value}`);
    if (!id) throw new Error(`Unknown attribute value ${code}:${value}`);
    return id;
  };

  // Category tree.
  const categories = new Map<string, { id: number; nameHe: string; parentSlug: string | null }>();
  const createCategory = async (seed: CategorySeed, sortOrder: number, parent?: { slug: string; id: number }) => {
    const category = await prisma.category.create({
      data: {
        slug: seed.slug,
        nameHe: seed.nameHe,
        sortOrder,
        parentId: parent?.id,
        attributes: {
          create: (seed.attributes ?? []).map((code, i) => ({ attributeId: attributeIds.get(code)!, sortOrder: i })),
        },
      },
    });
    categories.set(seed.slug, { id: category.id, nameHe: seed.nameHe, parentSlug: parent?.slug ?? null });
    for (const [i, child] of (seed.children ?? []).entries())
      await createCategory(child, i, { slug: seed.slug, id: category.id });
  };
  for (const [i, seed] of CATEGORIES.entries()) await createCategory(seed, i);

  const rooms = await Promise.all(
    ROOMS.map((r, i) => prisma.room.create({ data: { slug: r.slug, nameHe: r.nameHe, sortOrder: i } })),
  );
  await prisma.searchSynonym.createMany({ data: SYNONYMS.map((terms) => ({ terms })) });

  // Products: one variant per size × color × fabric × chaise side.
  let variantCount = 0;
  for (const [index, p] of PRODUCTS.entries()) {
    const category = categories.get(p.category);
    if (!category) throw new Error(`Unknown category ${p.category}`);
    const rootSlug = category.parentSlug ?? p.category;
    const createdAt = new Date(Date.now() - p.createdDaysAgo * DAY);

    const productValueIds = Object.entries(p.attributes).flatMap(([code, values]) =>
      values.map((v) => valueId(code, v)),
    );
    const variants = [];
    let order = 0;
    for (const size of p.sizes) {
      for (const color of p.colors) {
        for (const fabric of p.fabrics ?? [null]) {
          for (const side of p.sides ?? [null]) {
            const premium = 1 + (fabric ? (FABRIC_PREMIUM[fabric] ?? 0) : 0);
            const price = roundTo10(size.price * premium) * 100;
            const compareAt = size.compareAt ? roundTo10(size.compareAt * premium) * 100 : null;
            const sku = [p.modelName, size.width, SKU_CODE[color], fabric && SKU_CODE[fabric], side && SKU_CODE[side]]
              .filter(Boolean)
              .join('-');
            variants.push({
              sku,
              price,
              compareAtPrice: compareAt,
              ...delivery(p.delivery),
              sortOrder: order++,
              widthCm: size.width,
              depthCm: size.depth,
              heightCm: size.height,
              weightKg: size.weight ?? null,
              seatHeightCm: size.seatHeight ?? null,
              seatDepthCm: size.seatDepth ?? null,
              chaiseWidthCm: size.chaiseWidth ?? null,
              chaiseDepthCm: size.chaiseDepth ?? null,
              valueIds: [
                valueId('color', color),
                ...(fabric ? [valueId('fabric', fabric)] : []),
                ...(side ? [valueId('chaise-side', side)] : []),
              ],
            });
          }
        }
      }
    }

    const categoryNames = [category.parentSlug && categories.get(category.parentSlug)!.nameHe, category.nameHe].filter(
      (n): n is string => !!n,
    );
    const labels = [...productValueIds, ...variants.flatMap((v) => v.valueIds)].map((id) => valueLabels.get(id)!);

    await prisma.product.create({
      data: {
        slug: p.slug,
        modelName: p.modelName,
        nameHe: p.nameHe,
        descriptionHe: p.descriptionHe,
        categoryId: category.id,
        countryOfOrigin: p.countryOfOrigin ?? null,
        warrantyMonths: p.warrantyMonths ?? null,
        careHe: CARE_HE[rootSlug] ?? null,
        requiresAssembly: p.requiresAssembly ?? false,
        sortOrder: index,
        popularity: p.popularity,
        createdAt,
        searchText: buildProductSearchText({
          modelName: p.modelName,
          nameHe: p.nameHe,
          descriptionHe: p.descriptionHe,
          categoryNamesHe: categoryNames,
          attributeLabelsHe: labels,
          skus: variants.map((v) => v.sku),
        }),
        rooms: { create: rooms.map((r) => ({ roomId: r.id })) },
        attributeValues: { create: productValueIds.map((attributeValueId) => ({ attributeValueId })) },
        images: {
          create: [
            { url: `/images/placeholder/${p.image}.svg`, altHe: p.nameHe, kind: ImageKind.CUTOUT, sortOrder: 0 },
            {
              url: `/images/placeholder/${p.image}-room.svg`,
              altHe: `${p.nameHe} בסלון`,
              kind: ImageKind.LIFESTYLE,
              sortOrder: 1,
            },
          ],
        },
        variants: {
          create: variants.map(({ valueIds: ids, ...v }) => ({
            ...v,
            attributeValues: { create: ids.map((attributeValueId) => ({ attributeValueId })) },
          })),
        },
      },
    });
    variantCount += variants.length;
  }

  console.log(
    `Seeded ${categories.size} categories, ${ATTRIBUTES.length} attributes, ${PRODUCTS.length} products, ${variantCount} variants.`,
  );
}

function delivery(d: ProductSeed['delivery']) {
  return {
    fulfillment: FULFILLMENT[d.mode],
    leadTimeDays: d.leadDays,
    stock: d.mode === 'in_stock' ? d.stock : 0,
    productionDays: d.mode === 'made_to_order' ? d.productionDays : null,
    expectedAt: d.mode === 'pre_order' ? new Date(Date.now() + d.expectedInDays * DAY) : null,
  };
}

function roundTo10(shekels: number): number {
  return Math.round(shekels / 10) * 10;
}

try {
  await main();
} finally {
  await prisma.$disconnect();
}
