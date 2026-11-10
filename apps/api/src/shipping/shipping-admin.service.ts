import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import type {
  AdminShippingConfig,
  AdminShippingRate,
  AdminShippingRatesInput,
  AdminShippingZone,
  AdminShippingZoneInput,
  ShippingAdminErrorCode,
} from '@hg/models';
import { Prisma } from '../generated/prisma/client.js';
import { AuditService } from '../audit/audit.service.js';
import { invalid, notFound } from '../catalog-admin/catalog-errors.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { DEFAULT_SETTINGS } from './shipping.service.js';

type Meta = { actorId: number; ip?: string };
type Tx = Prisma.TransactionClient;

/** Name of the default row in the admin table. */
export const DEFAULT_RATE_NAME = 'ברירת מחדל';

/** 409: the locality already belongs to another zone (a locality is in at most one zone). */
export class LocalityTakenError extends HttpException {
  constructor(extra: { localityNameHe?: string; zoneName?: string } = {}) {
    const code: ShippingAdminErrorCode = 'locality_taken';
    super({ statusCode: HttpStatus.CONFLICT, code, ...extra }, HttpStatus.CONFLICT);
  }
}

const ZONE_SELECT = {
  id: true,
  name: true,
  surcharge: true,
  localities: { select: { locality: { select: { id: true, nameHe: true } } } },
} as const;

/**
 * The shipping price list in the admin (spec §4.4, ADM-07): rates per top-level category plus the default row,
 * the settings, and the remote zones. Every change is audited in the same transaction.
 */
@Injectable()
export class ShippingAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async config(tx: Tx = this.prisma): Promise<AdminShippingConfig> {
    const [rates, zones] = await Promise.all([
      this.rates(tx),
      tx.shippingZone.findMany({ orderBy: { id: 'asc' }, select: ZONE_SELECT }),
    ]);
    const settings = await tx.shippingSettings.findUnique({
      where: { id: 1 },
      select: { additionalItemPercent: true, floorSurcharge: true, floorSurchargeFrom: true },
    });
    return { rates, settings: settings ?? DEFAULT_SETTINGS, zones: zones.map(toZone) };
  }

  /** Replaces the whole price list and the settings in one transaction. */
  async saveRates(input: AdminShippingRatesInput, meta: Meta): Promise<AdminShippingConfig> {
    return this.prisma.$transaction(async (tx) => {
      const before = await this.config(tx);
      const topLevel = new Set(before.rates.map((r) => r.categoryId));
      input.rates.forEach((r, i) => {
        if (!topLevel.has(r.categoryId)) throw invalid(`rates.${i}.categoryId`);
      });

      const keep = input.rates.filter(
        (r): r is { categoryId: number | null; deliveryPrice: number; assemblyPrice: number } =>
          r.deliveryPrice !== null && r.assemblyPrice !== null,
      );
      const keptCategories = keep.flatMap((r) => (r.categoryId === null ? [] : [r.categoryId]));
      await tx.shippingRate.deleteMany({ where: { categoryId: { not: null, notIn: keptCategories } } });
      for (const { categoryId, deliveryPrice, assemblyPrice } of keep) {
        const data = { deliveryPrice, assemblyPrice };
        if (categoryId === null) {
          // One default row (partial unique index): update it, or create it the first time.
          const { count } = await tx.shippingRate.updateMany({ where: { categoryId: null }, data });
          if (count === 0) await tx.shippingRate.create({ data: { categoryId: null, ...data } });
        } else {
          await tx.shippingRate.upsert({ where: { categoryId }, create: { categoryId, ...data }, update: data });
        }
      }
      await tx.shippingSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...input.settings },
        update: input.settings,
      });

      const after = await this.config(tx);
      const snapshot = (c: AdminShippingConfig) => ({ rates: c.rates, settings: c.settings });
      if (JSON.stringify(snapshot(before)) !== JSON.stringify(snapshot(after)))
        await this.audit.record(
          {
            ...meta,
            action: 'shipping.rates.update',
            entityType: 'shipping',
            before: snapshot(before),
            after: snapshot(after),
          },
          tx,
        );
      return after;
    });
  }

  async createZone(input: AdminShippingZoneInput, meta: Meta): Promise<AdminShippingZone> {
    return this.inZoneTx(async (tx) => {
      await checkLocalities(tx, input.localityIds, null);
      const zone = await tx.shippingZone.create({
        data: {
          name: input.name,
          surcharge: input.surcharge,
          localities: { create: input.localityIds.map((localityId) => ({ localityId })) },
        },
        select: ZONE_SELECT,
      });
      await this.audit.record(
        {
          ...meta,
          action: 'shipping_zone.create',
          entityType: 'shipping_zone',
          entityId: zone.id,
          after: zoneInput(toZone(zone)),
        },
        tx,
      );
      return toZone(zone);
    });
  }

  async updateZone(id: number, input: AdminShippingZoneInput, meta: Meta): Promise<AdminShippingZone> {
    return this.inZoneTx(async (tx) => {
      const existing = await tx.shippingZone.findUnique({ where: { id }, select: ZONE_SELECT });
      if (!existing) throw notFound();
      await checkLocalities(tx, input.localityIds, id);
      await tx.zoneLocality.deleteMany({ where: { zoneId: id } });
      const zone = await tx.shippingZone.update({
        where: { id },
        data: {
          name: input.name,
          surcharge: input.surcharge,
          localities: { create: input.localityIds.map((localityId) => ({ localityId })) },
        },
        select: ZONE_SELECT,
      });
      const before = zoneInput(toZone(existing));
      const after = zoneInput(toZone(zone));
      if (JSON.stringify(before) !== JSON.stringify(after))
        await this.audit.record(
          { ...meta, action: 'shipping_zone.update', entityType: 'shipping_zone', entityId: id, before, after },
          tx,
        );
      return toZone(zone);
    });
  }

  async deleteZone(id: number, meta: Meta): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const existing = await tx.shippingZone.findUnique({ where: { id }, select: ZONE_SELECT });
      if (!existing) throw notFound();
      await tx.shippingZone.delete({ where: { id } });
      await this.audit.record(
        {
          ...meta,
          action: 'shipping_zone.delete',
          entityType: 'shipping_zone',
          entityId: id,
          before: zoneInput(toZone(existing)),
        },
        tx,
      );
    });
  }

  /** Default row first, then every top-level category in tree order, each with its own rate or none. */
  private async rates(tx: Tx): Promise<AdminShippingRate[]> {
    const [categories, rates] = await Promise.all([
      tx.category.findMany({
        where: { parentId: null },
        orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }],
        select: { id: true, nameHe: true },
      }),
      tx.shippingRate.findMany({ select: { categoryId: true, deliveryPrice: true, assemblyPrice: true } }),
    ]);
    const byCategory = new Map(rates.map((r) => [r.categoryId, r]));
    const fallback = byCategory.get(null);
    return [
      {
        categoryId: null,
        categoryNameHe: DEFAULT_RATE_NAME,
        deliveryPrice: fallback?.deliveryPrice ?? 0,
        assemblyPrice: fallback?.assemblyPrice ?? 0,
      },
      ...categories.map((c) => ({
        categoryId: c.id,
        categoryNameHe: c.nameHe,
        deliveryPrice: byCategory.get(c.id)?.deliveryPrice ?? null,
        assemblyPrice: byCategory.get(c.id)?.assemblyPrice ?? null,
      })),
    ];
  }

  /** A save that raced another one onto the same locality hits the unique index: still a 409. */
  private async inZoneTx<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.$transaction(work);
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') throw new LocalityTakenError();
      throw e;
    }
  }
}

/** 400 for an unknown locality; 409 naming the zone for a locality that is already in another zone. */
async function checkLocalities(tx: Tx, localityIds: number[], zoneId: number | null): Promise<void> {
  if (localityIds.length === 0) return;
  const known = await tx.locality.count({ where: { id: { in: localityIds } } });
  if (known !== localityIds.length) throw invalid('localityIds');
  const taken = await tx.zoneLocality.findFirst({
    where: { localityId: { in: localityIds }, ...(zoneId === null ? {} : { zoneId: { not: zoneId } }) },
    orderBy: { localityId: 'asc' },
    select: { locality: { select: { nameHe: true } }, zone: { select: { name: true } } },
  });
  if (taken) throw new LocalityTakenError({ localityNameHe: taken.locality.nameHe, zoneName: taken.zone.name });
}

type ZoneRow = {
  id: number;
  name: string;
  surcharge: number;
  localities: { locality: { id: number; nameHe: string } }[];
};

/** Localities in Hebrew alphabetical order. */
function toZone(z: ZoneRow): AdminShippingZone {
  return {
    id: z.id,
    name: z.name,
    surcharge: z.surcharge,
    localities: z.localities.map((l) => l.locality).sort((a, b) => a.nameHe.localeCompare(b.nameHe, 'he')),
  };
}

/** What the audit log keeps of a zone; locality codes in ascending order so before and after compare. */
function zoneInput(z: AdminShippingZone): AdminShippingZoneInput {
  return { name: z.name, surcharge: z.surcharge, localityIds: z.localities.map((l) => l.id).sort((a, b) => a - b) };
}
