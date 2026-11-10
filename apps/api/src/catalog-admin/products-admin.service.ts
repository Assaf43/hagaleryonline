import { Injectable } from '@nestjs/common';
import type {
  ActivationProblem,
  AdminProduct,
  AdminProductInput,
  AdminProductPage,
  AdminVariant,
  FulfillmentMode,
  ProductStatusFilter,
  RelatedPick,
} from '@hg/models';
import { AttributeScope, FulfillmentMode as DbFulfillment, Prisma, RelationKind } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import { SearchIndexer } from '../catalog/search/search-indexer.js';
import { imageFiles, thumbUrl, toAdminImage } from '../media/image-urls.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { changedFields } from './catalog-input.js';
import { conflict, duplicate, hasOrders, incomplete, invalid, notFound } from './catalog-errors.js';

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
const imageOrder = [{ sortOrder: 'asc' }, { id: 'asc' }] satisfies Prisma.ImageOrderByWithRelationInput[];
/** The main photo, enough for a thumbnail. */
const firstImage = { orderBy: imageOrder, take: 1, select: { url: true, storageKey: true, widths: true } };
const productInclude = {
  rooms: { select: { roomId: true } },
  attributeValues: valueCodes,
  variants: { orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], include: { attributeValues: valueCodes } },
  images: { orderBy: imageOrder, include: { colorValue: { select: { code: true } } } },
  relations: {
    orderBy: [{ position: 'asc' }, { relatedId: 'asc' }],
    include: {
      related: { select: { id: true, modelName: true, nameHe: true, active: true, images: firstImage } },
    },
  },
} satisfies Prisma.ProductInclude;
type ProductRow = Prisma.ProductGetPayload<{ include: typeof productInclude }>;
type VariantRow = ProductRow['variants'][number];

/** Input key of each relation kind (decision 67). */
const RELATION_KINDS = [
  ['goesWith', RelationKind.goes_with],
  ['similar', RelationKind.similar],
] as const;
type RelationLists = { goesWith: number[]; similar: number[] };
type Links = RelationLists & { goesWithAutofill: boolean; similarAutofill: boolean };

export type Meta = { actorId: number; ip?: string };

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
    private readonly storage: StorageProvider,
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
        include: { variants: { select: { price: true, stock: true, active: true } }, images: firstImage },
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
          thumbnailUrl: p.images[0] ? thumbUrl(this.storage, p.images[0]) : null,
        };
      }),
    };
  }

  async get(id: number): Promise<AdminProduct> {
    const row = await this.prisma.product.findUnique({ where: { id }, include: productInclude });
    if (!row) throw notFound();
    return toAdminProduct(row, this.storage);
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
      // An ordered product stays: orders link to its variants (CHK-09). Staff hide it instead. The variant rows are
      // locked first (like checkout does), so an order placed at this moment is either counted or never created.
      await tx.$queryRaw`SELECT id FROM variants WHERE product_id = ${id} ORDER BY id FOR UPDATE`;
      if ((await tx.orderItem.count({ where: { variant: { productId: id } } })) > 0) throw hasOrders();
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
    await this.storage.remove(row.images.flatMap(imageFiles)).catch(() => undefined);
  }

  private async save(id: number | null, input: AdminProductInput, meta: Meta): Promise<AdminProduct> {
    const productId = await this.prisma
      .$transaction((tx) => this.saveInTx(tx, id, input, meta), { timeout: 30_000 })
      .catch(uniqueToDuplicate);
    await this.cache.invalidate('catalog:');
    return this.get(productId);
  }

  /** The editable form of a product, read inside a transaction (the Excel import merges into it). */
  async getInTx(tx: Prisma.TransactionClient, id: number): Promise<AdminProduct> {
    const row = await tx.product.findUnique({ where: { id }, include: productInclude });
    if (!row) throw notFound();
    return toAdminProduct(row, this.storage);
  }

  /**
   * Writes one product inside the caller's transaction: checks, product, rooms, attributes,
   * variants, audit entries and search text. The caller invalidates the catalog cache afterwards.
   */
  async saveInTx(tx: Prisma.TransactionClient, id: number | null, input: AdminProductInput, meta: Meta) {
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
    await checkRelations(tx, id, input.relations);
    if (input.active) {
      const imageCount = id ? await tx.image.count({ where: { productId: id } }) : 0;
      const problems = activationProblems(input, category.active, imageCount);
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
      ...(input.goesWithAutofill === undefined ? {} : { goesWithAutofill: input.goesWithAutofill }),
      ...(input.similarAutofill === undefined ? {} : { similarAutofill: input.similarAutofill }),
    };
    const product = id ? await tx.product.update({ where: { id }, data }) : await tx.product.create({ data });
    await tx.productRoom.deleteMany({ where: { productId: product.id } });
    await tx.productRoom.createMany({ data: input.roomIds.map((roomId) => ({ productId: product.id, roomId })) });
    await tx.productAttributeValue.deleteMany({ where: { productId: product.id } });
    await tx.productAttributeValue.createMany({
      data: productValueIds.map((attributeValueId) => ({ productId: product.id, attributeValueId })),
    });

    // Related picks: only when the input carries them (the Excel import never does).
    const storedLinks: RelationLists = existing ? relationLists(existing) : { goesWith: [], similar: [] };
    if (input.relations) await writeRelations(tx, product.id, storedLinks, input.relations);
    const links: Links = {
      ...(input.relations ?? storedLinks),
      goesWithAutofill: product.goesWithAutofill,
      similarAutofill: product.similarAutofill,
    };

    if (existing) {
      const change = changedFields(
        productSummary(toAdminProduct(existing, this.storage), {
          ...storedLinks,
          goesWithAutofill: existing.goesWithAutofill,
          similarAutofill: existing.similarAutofill,
        }),
        productSummary(input, links),
      );
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
          after: { modelName: input.modelName, nameHe: input.nameHe, active: input.active, ...links },
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
  }
}

/** A unique index caught what the checks could not (two saves racing for the same SKU). */
export function uniqueToDuplicate(e: unknown): never {
  if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw duplicate('sku');
  throw e;
}

/** What stops a product from being shown on the site. */
export function activationProblems(
  input: Pick<AdminProductInput, 'variants'>,
  categoryActive: boolean,
  imageCount: number,
): ActivationProblem[] {
  const problems: ActivationProblem[] = [];
  if (!input.variants.some((v) => v.active)) problems.push('no_variants');
  if (imageCount === 0) problems.push('no_images');
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

/** Picks must be other, existing products (decision 67); the parser already refused duplicates. */
async function checkRelations(
  tx: Prisma.TransactionClient,
  id: number | null,
  relations: AdminProductInput['relations'],
) {
  if (!relations) return;
  for (const [key] of RELATION_KINDS) {
    const list = relations[key];
    if (id !== null && list.includes(id)) throw invalid(`relations.${key}`);
    if (list.length && (await tx.product.count({ where: { id: { in: list } } })) !== list.length)
      throw invalid(`relations.${key}`);
  }
}

function relationLists(p: Pick<ProductRow, 'relations'>): RelationLists {
  const of = (kind: RelationKind) => p.relations.filter((r) => r.kind === kind).map((r) => r.relatedId);
  return { goesWith: of(RelationKind.goes_with), similar: of(RelationKind.similar) };
}

/**
 * Replaces this product's side of the links with `next` and keeps the mirrored rows in step: an
 * added link goes last on the other product's side, a removed one disappears from both sides. Every
 * product on the other side of a change gets a new `updatedAt`, so an editor who opened it earlier
 * gets the usual conflict instead of silently dropping the link by saving an older list.
 */
async function writeRelations(
  tx: Prisma.TransactionClient,
  productId: number,
  stored: RelationLists,
  next: RelationLists,
) {
  const changes = RELATION_KINDS.map(([key, kind]) => ({
    kind,
    ids: next[key],
    added: next[key].filter((x) => !stored[key].includes(x)),
    removed: stored[key].filter((x) => !next[key].includes(x)),
  }));
  const others = [...new Set(changes.flatMap((c) => [...c.added, ...c.removed]))].sort((a, b) => a - b);
  // Ascending id order, so concurrent saves lock the other products in the same order.
  if (others.length) await tx.$queryRaw`SELECT id FROM products WHERE id = ANY(${others}) ORDER BY id FOR UPDATE`;

  for (const { kind, ids, added, removed } of changes) {
    if (removed.length)
      await tx.productRelation.deleteMany({ where: { kind, productId: { in: removed }, relatedId: productId } });
    // This side is rewritten whole, in the new order.
    await tx.productRelation.deleteMany({ where: { kind, productId } });
    await tx.productRelation.createMany({
      data: ids.map((relatedId, position) => ({ productId, relatedId, kind, position })),
    });
    if (!added.length) continue;
    const last = new Map(
      (
        await tx.productRelation.groupBy({
          by: ['productId'],
          where: { kind, productId: { in: added } },
          _max: { position: true },
        })
      ).map((g) => [g.productId, g._max.position ?? -1]),
    );
    await tx.productRelation.createMany({
      data: added.map((other) => ({
        productId: other,
        relatedId: productId,
        kind,
        position: (last.get(other) ?? -1) + 1,
      })),
    });
  }
  if (others.length) await tx.product.updateMany({ where: { id: { in: others } }, data: { updatedAt: new Date() } });
}

function auditBase(meta: Meta) {
  return { actorId: meta.actorId, ip: meta.ip };
}

/** The product fields the audit log compares (variants are logged one by one). */
function productSummary(
  p: Omit<AdminProductInput, 'variants' | 'expectedUpdatedAt' | 'relations' | 'goesWithAutofill' | 'similarAutofill'>,
  links: Links,
) {
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
    goesWith: links.goesWith,
    similar: links.similar,
    goesWithAutofill: links.goesWithAutofill,
    similarAutofill: links.similarAutofill,
  };
}

function variantSummary(v: AdminVariant) {
  const { id: _id, options, ...rest } = v;
  return { ...rest, options: Object.fromEntries(Object.entries(options).sort(([a], [b]) => a.localeCompare(b))) };
}

function toAdminProduct(p: ProductRow, storage: StorageProvider): AdminProduct {
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
    relations: {
      goesWith: relatedPicks(p, RelationKind.goes_with, storage),
      similar: relatedPicks(p, RelationKind.similar, storage),
    },
    goesWithAutofill: p.goesWithAutofill,
    similarAutofill: p.similarAutofill,
    images: p.images.map((i) => toAdminImage(storage, i)),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
  };
}

/** This product's picks of one kind, in its own order — hidden products included (the form flags them). */
function relatedPicks(p: ProductRow, kind: RelationKind, storage: StorageProvider): RelatedPick[] {
  return p.relations
    .filter((r) => r.kind === kind)
    .map(({ related: r }) => ({
      id: r.id,
      modelName: r.modelName,
      nameHe: r.nameHe,
      active: r.active,
      thumbnailUrl: r.images[0] ? thumbUrl(storage, r.images[0]) : null,
    }));
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
