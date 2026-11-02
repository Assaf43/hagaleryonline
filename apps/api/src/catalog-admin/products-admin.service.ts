import { Injectable } from '@nestjs/common';
import type {
  ActivationProblem,
  AdminProduct,
  AdminProductInput,
  AdminProductPage,
  AdminVariant,
  FulfillmentMode,
  ProductStatusFilter,
} from '@hg/models';
import { AttributeScope, FulfillmentMode as DbFulfillment, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import { SearchIndexer } from '../catalog/search/search-indexer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { changedFields } from './catalog-input.js';
import { conflict, duplicate, incomplete, invalid, notFound } from './catalog-errors.js';

export const PRODUCTS_PAGE_SIZE = 30;

const TO_DB: Record<FulfillmentMode, DbFulfillment> = {
  in_stock: DbFulfillment.IN_STOCK,
  pre_order: DbFulfillment.PRE_ORDER,
  made_to_order: DbFulfillment.MADE_TO_ORDER,
  out_of_stock: DbFulfillment.OUT_OF_STOCK,
};
const FROM_DB = Object.fromEntries(Object.entries(TO_DB).map(([k, v]) => [v, k])) as Record<
  DbFulfillment,
  FulfillmentMode
>;

const valueCodes = { select: { attributeValue: { select: { code: true, attribute: { select: { code: true } } } } } };
const productInclude = {
  rooms: { select: { roomId: true } },
  attributeValues: valueCodes,
  variants: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { attributeValues: valueCodes } },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type VariantRow = ProductRow['variants'][number];

type Meta = { actorId: number; ip?: string };

/**
 * Products and their variants in the admin (Phase 2b, ADM-02, ADM-12). One save writes the whole
 * product — details, rooms, attributes and every variant — in one transaction, rebuilds its search
 * text, records each change in the audit log and refreshes the storefront's catalog cache.
 */
@Injectable()
export class ProductsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
    private readonly indexer: SearchIndexer,
  ) {}

  async list(filter: {
    q?: string;
    categoryId?: number;
    status: ProductStatusFilter;
    page: number;
  }): Promise<AdminProductPage> {
    const and: Prisma.ProductWhereInput[] = [];
    if (filter.status !== 'all') and.push({ active: filter.status === 'active' });
    if (filter.categoryId)
      and.push({ OR: [{ categoryId: filter.categoryId }, { category: { parentId: filter.categoryId } }] });
    if (filter.q) {
      const q = filter.q.trim();
      and.push({
        OR: [
          { modelName: { contains: q, mode: 'insensitive' } },
          { nameHe: { contains: q } },
          { slug: { contains: q.toLowerCase() } },
          { variants: { some: { sku: { contains: q, mode: 'insensitive' } } } },
        ],
      });
    }
    const where: Prisma.ProductWhereInput = { AND: and };
    const [total, rows] = await Promise.all([
      this.prisma.product.count({ where }),
      this.prisma.product.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * PRODUCTS_PAGE_SIZE,
        take: PRODUCTS_PAGE_SIZE,
        include: { variants: { select: { price: true, stock: true, active: true } } },
      }),
    ]);
    return {
      total,
      page: filter.page,
      pageSize: PRODUCTS_PAGE_SIZE,
      items: rows.map((p) => {
        const active = p.variants.filter((v) => v.active);
        return {
          id: p.id,
          slug: p.slug,
          modelName: p.modelName,
          nameHe: p.nameHe,
          categoryId: p.categoryId,
          active: p.active,
          variantCount: p.variants.length,
          priceFrom: active.length ? Math.min(...active.map((v) => v.price)) : null,
          totalStock: active.reduce((sum, v) => sum + v.stock, 0),
          updatedAt: p.updatedAt.toISOString(),
        };
      }),
    };
  }

  async get(id: number): Promise<AdminProduct> {
    const row = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!row) throw notFound();
    return toAdminProduct(row);
  }

  create(input: AdminProductInput, meta: Meta): Promise<AdminProduct> {
    return this.save(null, input, meta);
  }

  update(id: number, input: AdminProductInput, meta: Meta): Promise<AdminProduct> {
    if (!input.expectedUpdatedAt) throw invalid('expectedUpdatedAt');
    return this.save(id, input, meta);
  }

  /**
   * Permanent removal — Super Admin only, for products created by mistake. Everyone else hides a
   * product instead. From Phase 4 on, a product that was ever ordered can only be hidden.
   */
  async remove(id: number, meta: Meta): Promise<void> {
    const row = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!row) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      await tx.product.delete({ where: { id } });
      await this.audit.record(
        {
          ...auditBase(meta),
          action: 'product.delete',
          entityType: 'product',
          entityId: id,
          before: { modelName: row.modelName, nameHe: row.nameHe, skus: row.variants.map((v) => v.sku) },
        },
        tx,
      );
    });
    await this.cache.invalidate('catalog:');
  }

  private async save(id: number | null, input: AdminProductInput, meta: Meta): Promise<AdminProduct> {
    const productId = await this.prisma
      .$transaction(
        async (tx) => {
          // Lock the row so two saves of the same product run one after the other.
          if (id) await tx.$queryRaw`SELECT id FROM products WHERE id = ${id} FOR UPDATE`;
          const existing = id ? await tx.product.findUnique({ where: { id }, include: productInclude }) : null;
          if (id && !existing) throw notFound();
          if (existing && existing.updatedAt.toISOString() !== input.expectedUpdatedAt) throw conflict();

          const category = await tx.category.findUnique({ where: { id: input.categoryId } });
          if (!category) throw invalid('categoryId');
          if ((await tx.room.count({ where: { id: { in: input.roomIds } } })) !== input.roomIds.length)
            throw invalid('roomIds');
          const { productValueIds, variantValueIds } = await resolveValues(tx, input);
          await checkUnique(tx, id, input);

          const existingVariants = new Map(existing?.variants.map((v) => [v.id, v]));
          input.variants.forEach((v, i) => {
            if (v.id !== undefined && !existingVariants.has(v.id)) throw invalid(`variants.${i}.id`);
          });
          if (input.active) {
            const problems = activationProblems(input, category.active);
            if (problems.length) throw incomplete(problems);
          }

          // Product, rooms and product attributes.
          const data = {
            slug: input.slug,
            modelName: input.modelName,
            nameHe: input.nameHe,
            descriptionHe: input.descriptionHe,
            categoryId: input.categoryId,
            countryOfOrigin: input.countryOfOrigin,
            warrantyMonths: input.warrantyMonths,
            careHe: input.careHe,
            requiresAssembly: input.requiresAssembly,
            active: input.active,
            sortOrder: input.sortOrder,
          };
          const product = id ? await tx.product.update({ where: { id }, data }) : await tx.product.create({ data });
          await tx.productRoom.deleteMany({ where: { productId: product.id } });
          await tx.productRoom.createMany({ data: input.roomIds.map((roomId) => ({ productId: product.id, roomId })) });
          await tx.productAttributeValue.deleteMany({ where: { productId: product.id } });
          await tx.productAttributeValue.createMany({
            data: productValueIds.map((attributeValueId) => ({ productId: product.id, attributeValueId })),
          });

          if (existing) {
            const change = changedFields(productSummary(toAdminProduct(existing)), productSummary(input));
            if (change)
              await this.audit.record(
                {
                  ...auditBase(meta),
                  action: 'product.update',
                  entityType: 'product',
                  entityId: product.id,
                  ...change,
                },
                tx,
              );
          } else {
            await this.audit.record(
              {
                ...auditBase(meta),
                action: 'product.create',
                entityType: 'product',
                entityId: product.id,
                after: { modelName: input.modelName, nameHe: input.nameHe, active: input.active },
              },
              tx,
            );
          }

          // Variants: removed first, so a SKU can move to another row in the same save.
          const kept = new Set(input.variants.map((v) => v.id).filter((v) => v !== undefined));
          const removed = [...existingVariants.values()].filter((v) => !kept.has(v.id));
          await tx.variant.deleteMany({ where: { id: { in: removed.map((v) => v.id) } } });
          for (const v of removed) {
            await this.audit.record(
              {
                ...auditBase(meta),
                action: 'variant.delete',
                entityType: 'variant',
                entityId: v.id,
                before: variantSummary(toAdminVariant(v)),
              },
              tx,
            );
          }

          for (const [i, v] of input.variants.entries()) {
            const vData = {
              sku: v.sku,
              price: v.price,
              compareAtPrice: v.compareAtPrice,
              stock: v.stock,
              fulfillment: TO_DB[v.fulfillment],
              leadTimeDays: v.leadTimeDays,
              productionDays: v.productionDays,
              expectedAt: v.expectedAt ? new Date(`${v.expectedAt}T00:00:00Z`) : null,
              active: v.active,
              sortOrder: i,
              widthCm: v.widthCm,
              depthCm: v.depthCm,
              heightCm: v.heightCm,
              weightKg: v.weightKg,
              seatHeightCm: v.seatHeightCm,
              seatDepthCm: v.seatDepthCm,
              chaiseWidthCm: v.chaiseWidthCm,
              chaiseDepthCm: v.chaiseDepthCm,
            };
            const before = v.id === undefined ? undefined : existingVariants.get(v.id)!;
            if (before) {
              const change = changedFields(variantSummary(toAdminVariant(before)), variantSummary(v));
              if (!change && before.sortOrder === i) continue;
              await tx.variant.update({ where: { id: before.id }, data: vData });
              await tx.variantAttributeValue.deleteMany({ where: { variantId: before.id } });
              await tx.variantAttributeValue.createMany({
                data: variantValueIds[i].map((attributeValueId) => ({ variantId: before.id, attributeValueId })),
              });
              if (change)
                await this.audit.record(
                  {
                    ...auditBase(meta),
                    action: 'variant.update',
                    entityType: 'variant',
                    entityId: before.id,
                    before: { sku: before.sku, ...change.before },
                    after: { sku: v.sku, ...change.after },
                  },
                  tx,
                );
            } else {
              const created = await tx.variant.create({
                data: {
                  ...vData,
                  productId: product.id,
                  attributeValues: { create: variantValueIds[i].map((attributeValueId) => ({ attributeValueId })) },
                },
              });
              await this.audit.record(
                {
                  ...auditBase(meta),
                  action: 'variant.create',
                  entityType: 'variant',
                  entityId: created.id,
                  after: variantSummary(v),
                },
                tx,
              );
            }
          }

          await this.indexer.reindex([product.id], tx);
          return product.id;
        },
        { timeout: 30_000 },
      )
      .catch((e: unknown) => {
        // A unique index caught what the checks above could not (two saves racing for the same SKU).
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw duplicate('sku');
        throw e;
      });

    await this.cache.invalidate('catalog:');
    return this.get(productId);
  }
}

/** What stops a product from being shown on the site. */
export function activationProblems(
  input: Pick<AdminProductInput, 'variants'>,
  categoryActive: boolean,
): ActivationProblem[] {
  const problems: ActivationProblem[] = [];
  if (!input.variants.some((v) => v.active)) problems.push('no_variants');
  if (!categoryActive) problems.push('category_hidden');
  return problems;
}

async function resolveValues(tx: Prisma.TransactionClient, input: AdminProductInput) {
  const attributes = new Map(
    (await tx.attribute.findMany({ include: { values: { select: { id: true, code: true } } } })).map((a) => [
      a.code,
      a,
    ]),
  );
  const valueId = (attribute: string, value: string, scope: AttributeScope, field: string) => {
    const a = attributes.get(attribute);
    const v = a?.scope === scope ? a.values.find((x) => x.code === value) : undefined;
    if (!v) throw invalid(field);
    return v.id;
  };

  const productValueIds = Object.entries(input.attributes).flatMap(([attribute, values]) =>
    values.map((value) => valueId(attribute, value, AttributeScope.PRODUCT, 'attributes')),
  );
  // Two variants with the same options and size would be impossible to choose between on the product page.
  const combinations = new Set<string>();
  const variantValueIds = input.variants.map((v, i) => {
    const key = JSON.stringify([
      Object.entries(v.options).sort(([a], [b]) => a.localeCompare(b)),
      v.widthCm,
      v.depthCm,
      v.heightCm,
    ]);
    if (combinations.has(key)) throw invalid(`variants.${i}.options`);
    combinations.add(key);
    return Object.entries(v.options).map(([attribute, value]) =>
      valueId(attribute, value, AttributeScope.VARIANT, `variants.${i}.options`),
    );
  });
  return { productValueIds, variantValueIds };
}

async function checkUnique(tx: Prisma.TransactionClient, id: number | null, input: AdminProductInput) {
  const others = { id: { not: id ?? 0 } };
  if (await tx.product.findFirst({ where: { ...others, modelName: input.modelName } }))
    throw duplicate('modelName', input.modelName);
  if (await tx.product.findFirst({ where: { ...others, slug: input.slug } })) throw duplicate('slug', input.slug);
  const sku = await tx.variant.findFirst({
    where: { sku: { in: input.variants.map((v) => v.sku) }, productId: { not: id ?? 0 } },
    select: { sku: true },
  });
  if (sku) throw duplicate('sku', sku.sku);
}

function auditBase(meta: Meta) {
  return { actorId: meta.actorId, ip: meta.ip };
}

/** The product fields the audit log compares (variants are logged one by one). */
function productSummary(p: Omit<AdminProductInput, 'variants' | 'expectedUpdatedAt'> & { variants?: unknown }) {
  return {
    modelName: p.modelName,
    nameHe: p.nameHe,
    slug: p.slug,
    descriptionHe: p.descriptionHe,
    categoryId: p.categoryId,
    roomIds: [...p.roomIds].sort((a, b) => a - b),
    attributes: Object.fromEntries(
      Object.entries(p.attributes)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, [...v].sort()]),
    ),
    countryOfOrigin: p.countryOfOrigin,
    warrantyMonths: p.warrantyMonths,
    careHe: p.careHe,
    requiresAssembly: p.requiresAssembly,
    active: p.active,
    sortOrder: p.sortOrder,
  };
}

function variantSummary(v: AdminVariant) {
  const { id: _id, options, ...rest } = v;
  return { ...rest, options: Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b))) };
}

function toAdminProduct(p: ProductRow): AdminProduct {
  const attributes: Record<string, string[]> = {};
  for (const { attributeValue: av } of p.attributeValues) {
    (attributes[av.attribute.code] ??= []).push(av.code);
  }
  return {
    id: p.id,
    slug: p.slug,
    modelName: p.modelName,
    nameHe: p.nameHe,
    descriptionHe: p.descriptionHe,
    categoryId: p.categoryId,
    roomIds: p.rooms.map((r) => r.roomId),
    attributes,
    countryOfOrigin: p.countryOfOrigin,
    warrantyMonths: p.warrantyMonths,
    careHe: p.careHe,
    requiresAssembly: p.requiresAssembly,
    active: p.active,
    sortOrder: p.sortOrder,
    variants: p.variants.map(toAdminVariant),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

function toAdminVariant(v: VariantRow): AdminVariant {
  const n = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());
  return {
    id: v.id,
    sku: v.sku,
    price: v.price,
    compareAtPrice: v.compareAtPrice,
    stock: v.stock,
    fulfillment: FROM_DB[v.fulfillment],
    leadTimeDays: v.leadTimeDays,
    productionDays: v.productionDays,
    expectedAt: v.expectedAt ? v.expectedAt.toISOString().slice(0, 10) : null,
    active: v.active,
    widthCm: v.widthCm.toNumber(),
    depthCm: v.depthCm.toNumber(),
    heightCm: v.heightCm.toNumber(),
    weightKg: n(v.weightKg),
    seatHeightCm: n(v.seatHeightCm),
    seatDepthCm: n(v.seatDepthCm),
    chaiseWidthCm: n(v.chaiseWidthCm),
    chaiseDepthCm: n(v.chaiseDepthCm),
    options: Object.fromEntries(v.attributeValues.map(({ attributeValue: av }) => [av.attribute.code, av.code])),
  };
}
