import { Injectable } from '@nestjs/common';
import type {
  AdminAttribute,
  AdminAttributeInput,
  AdminAttributeValueInput,
  AdminCategoryInput,
  AdminRoomInput,
  AdminSynonym,
  CatalogStructure,
} from '@hg/models';
import { AttributeScope, Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import { SearchIndexer } from '../catalog/search/search-indexer.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { changedFields } from './catalog-input.js';
import { duplicate, inUse, invalid, notFound } from './catalog-errors.js';

type Meta = { actorId: number; ip?: string };

/**
 * Categories, rooms, closed value lists and search synonyms (Phase 2b, ADM-03, ADM-17).
 * Nothing here is deleted except unused values and synonym groups: categories and rooms are hidden.
 * A rename that products borrow for search (category, value label) rebuilds every product's search text.
 */
@Injectable()
export class StructureAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
    private readonly indexer: SearchIndexer,
  ) {}

  async structure(): Promise<CatalogStructure> {
    const [categories, rooms, attributes, synonyms] = await Promise.all([
      this.prisma.category.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: {
          attributes: { orderBy: { sortOrder: 'asc' }, select: { attribute: { select: { code: true } } } },
          _count: { select: { products: true } },
        },
      }),
      this.prisma.room.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: { _count: { select: { products: true } } },
      }),
      this.prisma.attribute.findMany({
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        include: {
          values: {
            orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
            include: { _count: { select: { products: true, variants: true } } },
          },
        },
      }),
      this.prisma.searchSynonym.findMany({ orderBy: { id: 'asc' } }),
    ]);
    return {
      categories: categories.map(({ attributes: attrs, _count, ...c }) => ({
        ...c,
        attributeCodes: attrs.map((a) => a.attribute.code),
        productCount: _count.products,
      })),
      rooms: rooms.map(({ _count, ...r }) => ({ ...r, productCount: _count.products })),
      attributes: attributes.map(toAdminAttribute),
      synonyms: synonyms.map(({ id, terms }) => ({ id, terms })),
    };
  }

  // ---------- Categories ----------

  async saveCategory(id: number | null, input: AdminCategoryInput, meta: Meta): Promise<void> {
    let reindex = false;
    await this.prisma.$transaction(async (tx) => {
      const existing = id
        ? await tx.category.findUnique({
            where: { id },
            include: { attributes: { orderBy: { sortOrder: 'asc' }, include: { attribute: true } } },
          })
        : null;
      if (id && !existing) throw notFound();
      if (await tx.category.findFirst({ where: { slug: input.slug, id: { not: id ?? 0 } } }))
        throw duplicate('slug', input.slug);
      if (input.parentId !== null) await checkParent(tx, id, input.parentId);

      const attributes = await tx.attribute.findMany({ where: { code: { in: input.attributeCodes } } });
      if (attributes.length !== input.attributeCodes.length) throw invalid('attributeCodes');
      const attributeId = new Map(attributes.map((a) => [a.code, a.id]));

      const { attributeCodes, ...data } = input;
      const category = id ? await tx.category.update({ where: { id }, data }) : await tx.category.create({ data });
      await tx.categoryAttribute.deleteMany({ where: { categoryId: category.id } });
      await tx.categoryAttribute.createMany({
        data: attributeCodes.map((code, sortOrder) => ({
          categoryId: category.id,
          attributeId: attributeId.get(code)!,
          sortOrder,
        })),
      });

      if (existing) {
        const before = { ...pick(existing), attributeCodes: existing.attributes.map((a) => a.attribute.code) };
        const change = changedFields(before, input);
        if (change)
          await this.audit.record(
            { ...meta, action: 'category.update', entityType: 'category', entityId: category.id, ...change },
            tx,
          );
        reindex = existing.nameHe !== input.nameHe || existing.parentId !== input.parentId;
      } else {
        await this.audit.record(
          { ...meta, action: 'category.create', entityType: 'category', entityId: category.id, after: input },
          tx,
        );
      }
    });
    await this.afterChange(reindex);
  }

  // ---------- Rooms ----------

  async saveRoom(id: number | null, input: AdminRoomInput, meta: Meta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = id ? await tx.room.findUnique({ where: { id } }) : null;
      if (id && !existing) throw notFound();
      if (await tx.room.findFirst({ where: { slug: input.slug, id: { not: id ?? 0 } } }))
        throw duplicate('slug', input.slug);
      const room = id ? await tx.room.update({ where: { id }, data: input }) : await tx.room.create({ data: input });
      const change = existing ? changedFields(pick(existing), input) : { after: input };
      if (change)
        await this.audit.record(
          {
            ...meta,
            action: existing ? 'room.update' : 'room.create',
            entityType: 'room',
            entityId: room.id,
            ...change,
          },
          tx,
        );
    });
    await this.afterChange(false);
  }

  // ---------- Attributes and their closed value lists ----------

  async saveAttribute(id: number | null, input: AdminAttributeInput, meta: Meta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = id ? await tx.attribute.findUnique({ where: { id } }) : null;
      if (id && !existing) throw notFound();
      const scope = input.scope === 'product' ? AttributeScope.PRODUCT : AttributeScope.VARIANT;
      // The code is in storefront URLs (attr.color=beige) and the scope decides where values are stored.
      if (existing && existing.code !== input.code) throw invalid('code');
      if (existing && existing.scope !== scope) throw invalid('scope');
      if (!existing && (await tx.attribute.findUnique({ where: { code: input.code } })))
        throw duplicate('code', input.code);

      const data = { nameHe: input.nameHe, filterable: input.filterable, sortOrder: input.sortOrder };
      const attribute = existing
        ? await tx.attribute.update({ where: { id: existing.id }, data })
        : await tx.attribute.create({ data: { ...data, code: input.code, scope } });
      const change = existing ? changedFields(pick(existing), data) : { after: input };
      if (change)
        await this.audit.record(
          {
            ...meta,
            action: existing ? 'attribute.update' : 'attribute.create',
            entityType: 'attribute',
            entityId: attribute.id,
            ...change,
          },
          tx,
        );
    });
    await this.afterChange(false);
  }

  async saveValue(attributeId: number, id: number | null, input: AdminAttributeValueInput, meta: Meta): Promise<void> {
    let reindex = false;
    await this.prisma.$transaction(async (tx) => {
      if (!(await tx.attribute.findUnique({ where: { id: attributeId } }))) throw notFound();
      const existing = id ? await tx.attributeValue.findFirst({ where: { id, attributeId } }) : null;
      if (id && !existing) throw notFound();
      if (existing && existing.code !== input.code) throw invalid('code');
      const others = { attributeId, id: { not: id ?? 0 } };
      if (await tx.attributeValue.findFirst({ where: { ...others, code: input.code } }))
        throw duplicate('code', input.code);
      if (await tx.attributeValue.findFirst({ where: { ...others, labelHe: input.labelHe } }))
        throw duplicate('labelHe', input.labelHe);

      const data = { labelHe: input.labelHe, swatchHex: input.swatchHex, sortOrder: input.sortOrder };
      const value = existing
        ? await tx.attributeValue.update({ where: { id: existing.id }, data })
        : await tx.attributeValue.create({ data: { ...data, code: input.code, attributeId } });
      const change = existing ? changedFields(pick(existing), data) : { after: input };
      if (change)
        await this.audit.record(
          {
            ...meta,
            action: existing ? 'attribute_value.update' : 'attribute_value.create',
            entityType: 'attribute_value',
            entityId: value.id,
            ...change,
          },
          tx,
        );
      reindex = !!existing && existing.labelHe !== input.labelHe;
    });
    await this.afterChange(reindex);
  }

  /** Only a value no product or variant uses; otherwise it would silently vanish from them. */
  async deleteValue(attributeId: number, id: number, meta: Meta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const value = await tx.attributeValue.findFirst({
        where: { id, attributeId },
        include: { _count: { select: { products: true, variants: true } } },
      });
      if (!value) throw notFound();
      if (value._count.products + value._count.variants > 0) throw inUse('value');
      await tx.attributeValue.delete({ where: { id } });
      await this.audit.record(
        {
          ...meta,
          action: 'attribute_value.delete',
          entityType: 'attribute_value',
          entityId: id,
          before: { code: value.code, labelHe: value.labelHe },
        },
        tx,
      );
    });
    await this.afterChange(false);
  }

  // ---------- Search synonyms (decision 47) ----------

  async saveSynonym(id: number | null, terms: string[], meta: Meta): Promise<AdminSynonym> {
    const saved = await this.prisma.$transaction(async (tx) => {
      const existing = id ? await tx.searchSynonym.findUnique({ where: { id } }) : null;
      if (id && !existing) throw notFound();
      const row = existing
        ? await tx.searchSynonym.update({ where: { id: existing.id }, data: { terms } })
        : await tx.searchSynonym.create({ data: { terms } });
      await this.audit.record(
        {
          ...meta,
          action: existing ? 'synonym.update' : 'synonym.create',
          entityType: 'synonym',
          entityId: row.id,
          before: existing ? { terms: existing.terms } : undefined,
          after: { terms },
        },
        tx,
      );
      return row;
    });
    await this.cache.invalidate('search:');
    return { id: saved.id, terms: saved.terms };
  }

  async deleteSynonym(id: number, meta: Meta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.searchSynonym.findUnique({ where: { id } });
      if (!existing) throw notFound();
      await tx.searchSynonym.delete({ where: { id } });
      await this.audit.record(
        { ...meta, action: 'synonym.delete', entityType: 'synonym', entityId: id, before: { terms: existing.terms } },
        tx,
      );
    });
    await this.cache.invalidate('search:');
  }

  private async afterChange(reindex: boolean) {
    if (reindex) await this.indexer.reindex();
    await this.cache.invalidate('catalog:');
  }
}

/** A category may not sit under itself or under one of its own sub-categories. */
async function checkParent(tx: Prisma.TransactionClient, id: number | null, parentId: number) {
  let current: number | null = parentId;
  for (let depth = 0; current !== null; depth++) {
    if (current === id || depth > 20) throw invalid('parentId');
    const parent: { parentId: number | null } | null = await tx.category.findUnique({
      where: { id: current },
      select: { parentId: true },
    });
    if (!parent) throw invalid('parentId');
    current = parent.parentId;
  }
}

/** The editable fields of a row, for comparing with the input. */
function pick<T extends object>(row: T) {
  const { id: _id, ...rest } = row as T & { id?: number };
  return rest as Record<string, unknown>;
}

function toAdminAttribute(
  a: Prisma.AttributeGetPayload<{
    include: { values: { include: { _count: { select: { products: true; variants: true } } } } };
  }>,
): AdminAttribute {
  return {
    id: a.id,
    code: a.code,
    nameHe: a.nameHe,
    scope: a.scope === AttributeScope.PRODUCT ? 'product' : 'variant',
    filterable: a.filterable,
    sortOrder: a.sortOrder,
    values: a.values.map(({ _count, attributeId: _a, ...v }) => ({
      ...v,
      usageCount: _count.products + _count.variants,
    })),
  };
}
