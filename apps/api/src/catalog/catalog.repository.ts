import { Injectable } from '@nestjs/common';
import type { Dimensions, FulfillmentMode, ImageRef, OptionAxis, ProductDetail } from '@hg/models';
import { AttributeScope, FulfillmentMode as DbFulfillment, Prisma, RelationKind } from '../generated/prisma/client.js';
import { toImageRef as imageRef } from '../media/image-urls.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { CatalogSnapshot, SnapshotAttribute, SnapshotCategory, SnapshotProduct } from './catalog-snapshot.js';
import { insertSizeAxis, SIZE_AXIS, sizeAxis } from './size-axis.js';

const FULFILLMENT: Record<DbFulfillment, FulfillmentMode> = {
  IN_STOCK: 'in_stock',
  PRE_ORDER: 'pre_order',
  MADE_TO_ORDER: 'made_to_order',
  OUT_OF_STOCK: 'out_of_stock',
};

/** The admin orders the photos; the first one is the product's main photo (decision 62). */
const imageOrder: Prisma.ImageOrderByWithRelationInput[] = [{ sortOrder: 'asc' }, { id: 'asc' }];

/** Color value code → first photo (in image order) linked to that color. */
function firstImagePerColor(
  storage: StorageProvider,
  images: Array<Parameters<typeof imageRef>[1] & { colorValue: { code: string } | null }>,
): Map<string, ImageRef> {
  const result = new Map<string, ImageRef>();
  for (const image of images) {
    const code = image.colorValue?.code;
    if (code && !result.has(code)) result.set(code, imageRef(storage, image));
  }
  return result;
}

@Injectable()
export class CatalogRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageProvider,
  ) {}

  /** The whole active catalog as an in-memory read model. */
  async loadSnapshot(): Promise<CatalogSnapshot> {
    const [categories, attributes, rooms, products] = await Promise.all([
      this.prisma.category.findMany({
        where: { active: true },
        include: { attributes: { orderBy: { sortOrder: 'asc' }, include: { attribute: true } } },
      }),
      this.prisma.attribute.findMany({ include: { values: true } }),
      this.prisma.room.findMany({ where: { active: true } }),
      this.prisma.product.findMany({
        where: { active: true, category: { active: true } },
        include: {
          rooms: { include: { room: true } },
          attributeValues: { include: { attributeValue: { include: { attribute: true } } } },
          variants: {
            where: { active: true },
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            include: { attributeValues: { include: { attributeValue: { include: { attribute: true } } } } },
          },
          images: { orderBy: imageOrder, include: { colorValue: { select: { code: true } } } },
          relations: { orderBy: [{ position: 'asc' }, { relatedId: 'asc' }], select: { relatedId: true, kind: true } },
        },
      }),
    ]);

    const categoriesById = buildCategoryTree(categories);
    const snapshotAttributes = new Map<string, SnapshotAttribute>(
      attributes.map((a) => [
        a.code,
        {
          code: a.code,
          nameHe: a.nameHe,
          scope: a.scope === AttributeScope.PRODUCT ? 'product' : 'variant',
          filterable: a.filterable,
          sortOrder: a.sortOrder,
          values: new Map(
            a.values.map((v) => [
              v.code,
              { code: v.code, labelHe: v.labelHe, hex: v.swatchHex, sortOrder: v.sortOrder },
            ]),
          ),
        },
      ]),
    );

    const snapshotProducts: SnapshotProduct[] = products
      .filter((p) => p.variants.length > 0 && categoriesById.has(p.categoryId))
      .map((p) => {
        const productAttributes = new Map<string, Set<string>>();
        for (const { attributeValue } of p.attributeValues) {
          const code = attributeValue.attribute.code;
          if (!productAttributes.has(code)) productAttributes.set(code, new Set());
          productAttributes.get(code)!.add(attributeValue.code);
        }
        return {
          id: p.id,
          slug: p.slug,
          modelName: p.modelName,
          nameHe: p.nameHe,
          categoryId: p.categoryId,
          roomSlugs: new Set(p.rooms.filter((r) => r.room.active).map((r) => r.room.slug)),
          sortOrder: p.sortOrder,
          popularity: p.popularity,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
          goesWithAutofill: p.goesWithAutofill,
          similarAutofill: p.similarAutofill,
          picks: {
            goesWith: p.relations.filter((r) => r.kind === RelationKind.goes_with).map((r) => r.relatedId),
            similar: p.relations.filter((r) => r.kind === RelationKind.similar).map((r) => r.relatedId),
          },
          attributes: productAttributes,
          variants: p.variants.map((v) => ({
            id: v.id,
            sku: v.sku,
            price: v.price,
            compareAtPrice: v.compareAtPrice,
            fulfillment: FULFILLMENT[v.fulfillment],
            leadTimeDays: v.leadTimeDays,
            sortOrder: v.sortOrder,
            widthCm: v.widthCm.toNumber(),
            depthCm: v.depthCm.toNumber(),
            options: new Map(v.attributeValues.map(({ attributeValue: av }) => [av.attribute.code, av.code])),
          })),
          image: p.images[0] ? imageRef(this.storage, p.images[0]) : null,
          colorImages: firstImagePerColor(this.storage, p.images),
        };
      });

    return {
      products: snapshotProducts,
      categoriesById,
      categories: new Map([...categoriesById.values()].map((c) => [c.slug, c])),
      attributes: snapshotAttributes,
      rooms: new Map(rooms.map((r) => [r.slug, { id: r.id, slug: r.slug, nameHe: r.nameHe, sortOrder: r.sortOrder }])),
    };
  }

  /** Full product page (PRD-01..PRD-08), or null when the product is missing or inactive. */
  async findProductDetail(slug: string, snapshot: CatalogSnapshot): Promise<ProductDetail | null> {
    const p = await this.prisma.product.findFirst({
      where: { slug, active: true, category: { active: true } },
      include: {
        rooms: { include: { room: true }, where: { room: { active: true } } },
        attributeValues: { include: { attributeValue: { include: { attribute: true } } } },
        images: { orderBy: imageOrder },
        variants: {
          where: { active: true },
          orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
          include: {
            attributeValues: { include: { attributeValue: { include: { attribute: true } } } },
          },
        },
      },
    });
    const category = p && snapshot.categoriesById.get(p.categoryId);
    if (!p || !category || p.variants.length === 0) return null;

    // Product-level attributes, grouped for the spec table.
    const specs = new Map<string, { code: string; nameHe: string; sortOrder: number; valuesHe: string[] }>();
    for (const { attributeValue: av } of p.attributeValues) {
      const spec = specs.get(av.attribute.code) ?? {
        code: av.attribute.code,
        nameHe: av.attribute.nameHe,
        sortOrder: av.attribute.sortOrder,
        valuesHe: [],
      };
      spec.valuesHe.push(av.labelHe);
      specs.set(spec.code, spec);
    }

    // Variant selectors: every variant attribute that is used, in attribute order.
    type Axis = OptionAxis & { sortOrder: number; valueOrder: Map<string, number> };
    const axes = new Map<string, Axis>();
    for (const v of p.variants) {
      for (const { attributeValue: av } of v.attributeValues) {
        const axis: Axis = axes.get(av.attribute.code) ?? {
          code: av.attribute.code,
          nameHe: av.attribute.nameHe,
          sortOrder: av.attribute.sortOrder,
          values: [],
          valueOrder: new Map(),
        };
        if (!axis.valueOrder.has(av.code)) {
          axis.valueOrder.set(av.code, av.sortOrder);
          axis.values.push({ code: av.code, labelHe: av.labelHe, hex: av.swatchHex });
        }
        axes.set(axis.code, axis);
      }
    }

    const attributeAxes: OptionAxis[] = [...axes.values()]
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(({ code, nameHe, values, valueOrder }) => ({
        code,
        nameHe,
        values: [...values].sort((a, b) => valueOrder.get(a.code)! - valueOrder.get(b.code)!),
      }));
    const size = axes.has(SIZE_AXIS)
      ? null
      : sizeAxis(p.variants.map((v) => ({ widthCm: v.widthCm.toNumber(), depthCm: v.depthCm.toNumber() })));
    const optionAxes = size
      ? insertSizeAxis(attributeAxes, size.axis, {
          fabricOrder: snapshot.attributes.get('fabric')?.sortOrder,
          axisOrder: (code) => axes.get(code)!.sortOrder,
        })
      : attributeAxes;

    return {
      id: p.id,
      slug: p.slug,
      modelName: p.modelName,
      nameHe: p.nameHe,
      descriptionHe: p.descriptionHe,
      breadcrumbs: category.pathIds.map((id) => {
        const c = snapshot.categoriesById.get(id)!;
        return { slug: c.slug, nameHe: c.nameHe };
      }),
      rooms: p.rooms.map((r) => ({ slug: r.room.slug, nameHe: r.room.nameHe })),
      specs: [...specs.values()]
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map(({ code, nameHe, valuesHe }) => ({ code, nameHe, valuesHe })),
      countryOfOrigin: p.countryOfOrigin,
      warrantyMonths: p.warrantyMonths,
      careHe: p.careHe,
      requiresAssembly: p.requiresAssembly,
      // Photos for every color here; each variant gets the photos of its color (decision 62).
      images: p.images.filter((i) => i.colorValueId === null).map((i) => imageRef(this.storage, i)),
      optionAxes,
      variants: p.variants.map((v, index) => ({
        sku: v.sku,
        price: v.price,
        compareAtPrice: v.compareAtPrice,
        inStock:
          v.fulfillment !== DbFulfillment.OUT_OF_STOCK && (v.fulfillment !== DbFulfillment.IN_STOCK || v.stock > 0),
        fulfillment: FULFILLMENT[v.fulfillment],
        leadTimeDays: v.leadTimeDays,
        productionDays: v.productionDays,
        expectedAt: v.expectedAt ? v.expectedAt.toISOString().slice(0, 10) : null,
        dimensions: toDimensions(v),
        options: {
          ...Object.fromEntries(v.attributeValues.map(({ attributeValue: av }) => [av.attribute.code, av.code])),
          ...(size ? { [SIZE_AXIS]: size.codes[index]! } : {}),
        },
        images: p.images
          .filter(
            (i) => i.colorValueId !== null && v.attributeValues.some((a) => a.attributeValueId === i.colorValueId),
          )
          .map((i) => imageRef(this.storage, i)),
      })),
    };
  }
}

function buildCategoryTree(
  rows: {
    id: number;
    slug: string;
    nameHe: string;
    parentId: number | null;
    sortOrder: number;
    attributes: { attribute: { code: string } }[];
  }[],
): Map<number, SnapshotCategory> {
  const byId = new Map<number, SnapshotCategory>(
    rows.map((c) => [
      c.id,
      {
        id: c.id,
        slug: c.slug,
        nameHe: c.nameHe,
        parentId: c.parentId,
        sortOrder: c.sortOrder,
        descendantIds: new Set([c.id]),
        pathIds: [],
        attributeCodes: c.attributes.map((a) => a.attribute.code),
      },
    ]),
  );

  for (const category of byId.values()) {
    // Walk up to the root; a category under an inactive parent is dropped from the tree.
    const path: number[] = [];
    let current: SnapshotCategory | undefined = category;
    while (current) {
      path.unshift(current.id);
      if (current.parentId === null) break;
      current = byId.get(current.parentId);
      if (!current) path.length = 0;
    }
    category.pathIds = path;
    for (const ancestorId of path) byId.get(ancestorId)?.descendantIds.add(category.id);
  }

  for (const [id, category] of byId) {
    if (category.pathIds.length === 0) byId.delete(id);
  }
  return byId;
}

function toDimensions(v: {
  widthCm: Prisma.Decimal;
  depthCm: Prisma.Decimal;
  heightCm: Prisma.Decimal;
  weightKg: Prisma.Decimal | null;
  seatHeightCm: Prisma.Decimal | null;
  seatDepthCm: Prisma.Decimal | null;
  chaiseWidthCm: Prisma.Decimal | null;
  chaiseDepthCm: Prisma.Decimal | null;
}): Dimensions {
  const n = (d: Prisma.Decimal | null) => (d === null ? null : d.toNumber());
  return {
    widthCm: v.widthCm.toNumber(),
    depthCm: v.depthCm.toNumber(),
    heightCm: v.heightCm.toNumber(),
    weightKg: n(v.weightKg),
    seatHeightCm: n(v.seatHeightCm),
    seatDepthCm: n(v.seatDepthCm),
    chaiseWidthCm: n(v.chaiseWidthCm),
    chaiseDepthCm: n(v.chaiseDepthCm),
  };
}
