import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { AuditPage } from '@hg/models';
import { Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';

/** Audit entries are kept two years (decision 54). */
export const AUDIT_RETENTION_MS = 2 * 365 * 24 * 60 * 60_000;
const PURGE_EVERY_MS = 24 * 60 * 60_000;
export const AUDIT_PAGE_SIZE = 50;

export interface AuditRecord {
  actorId: number | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  before?: unknown;
  after?: unknown;
  ip?: string | null;
}

/** Who changed what, when, before and after (ADM-11). Never store secrets in before/after. */
@Injectable()
export class AuditService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditService.name);
  private timer?: NodeJS.Timeout;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.purgeExpired(), PURGE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy() {
    clearInterval(this.timer);
  }

  async record(entry: AuditRecord, tx: Prisma.TransactionClient = this.prisma): Promise<void> {
    await tx.auditLog.create({
      data: {
        actorId: entry.actorId,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId == null ? null : String(entry.entityId),
        before: toJson(entry.before),
        after: toJson(entry.after),
        ip: entry.ip ?? null,
      },
    });
  }

  async list(filter: { entityType?: string; entityId?: string; page: number }): Promise<AuditPage> {
    const where: Prisma.AuditLogWhereInput = {
      ...(filter.entityType ? { entityType: filter.entityType } : {}),
      ...(filter.entityId ? { entityId: filter.entityId } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * AUDIT_PAGE_SIZE,
        take: AUDIT_PAGE_SIZE,
        include: { actor: { select: { id: true, name: true } } },
      }),
    ]);
    const labels = await this.labels(rows);
    return {
      total,
      page: filter.page,
      pageSize: AUDIT_PAGE_SIZE,
      items: rows.map((r) => ({
        id: r.id,
        createdAt: r.createdAt.toISOString(),
        actor: r.actor,
        action: r.action,
        entityType: r.entityType,
        entityId: r.entityId,
        entityLabel: (r.entityId && labels.get(`${r.entityType}:${r.entityId}`)) || deletedLabel(r.before),
        before: r.before,
        after: r.after,
      })),
    };
  }

  /** Readable names for the entities on a page: user name, model name, SKU, category, value label or zone name. */
  private async labels(rows: { entityType: string; entityId: string | null }[]): Promise<Map<string, string>> {
    const idsOf = (type: string) => [
      ...new Set(rows.filter((r) => r.entityType === type && r.entityId).map((r) => Number(r.entityId))),
    ];
    const lookups: [string, Promise<{ id: number; label: string }[]>][] = [
      [
        'admin_user',
        this.prisma.adminUser
          .findMany({ where: { id: { in: idsOf('admin_user') } } })
          .then((l) => l.map((u) => ({ id: u.id, label: u.name }))),
      ],
      [
        'product',
        this.prisma.product
          .findMany({ where: { id: { in: idsOf('product') } } })
          .then((l) => l.map((p) => ({ id: p.id, label: `${p.modelName} · ${p.nameHe}` }))),
      ],
      [
        'variant',
        this.prisma.variant
          .findMany({ where: { id: { in: idsOf('variant') } } })
          .then((l) => l.map((v) => ({ id: v.id, label: v.sku }))),
      ],
      [
        'category',
        this.prisma.category
          .findMany({ where: { id: { in: idsOf('category') } } })
          .then((l) => l.map((c) => ({ id: c.id, label: c.nameHe }))),
      ],
      [
        'room',
        this.prisma.room
          .findMany({ where: { id: { in: idsOf('room') } } })
          .then((l) => l.map((r) => ({ id: r.id, label: r.nameHe }))),
      ],
      [
        'attribute',
        this.prisma.attribute
          .findMany({ where: { id: { in: idsOf('attribute') } } })
          .then((l) => l.map((a) => ({ id: a.id, label: a.nameHe }))),
      ],
      [
        'attribute_value',
        this.prisma.attributeValue
          .findMany({ where: { id: { in: idsOf('attribute_value') } } })
          .then((l) => l.map((v) => ({ id: v.id, label: v.labelHe }))),
      ],
      [
        'shipping_zone',
        this.prisma.shippingZone
          .findMany({ where: { id: { in: idsOf('shipping_zone') } } })
          .then((l) => l.map((z) => ({ id: z.id, label: z.name }))),
      ],
      [
        'promotion',
        this.prisma.promotion
          .findMany({ where: { id: { in: idsOf('promotion') } } })
          .then((l) => l.map((p) => ({ id: p.id, label: p.name }))),
      ],
    ];
    const labels = new Map<string, string>();
    for (const [type, lookup] of lookups) {
      for (const { id, label } of await lookup) labels.set(`${type}:${id}`, label);
    }
    return labels;
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - AUDIT_RETENTION_MS) } },
    });
    if (count) this.logger.log(`Purged ${count} audit entries older than two years`);
    return count;
  }
}

/** A deleted entity has no row to name it; fall back to what was recorded about it. */
function deletedLabel(before: Prisma.JsonValue): string | null {
  const b = (before ?? {}) as Record<string, unknown>;
  for (const key of ['sku', 'modelName', 'labelHe', 'nameHe', 'שם'])
    if (typeof b[key] === 'string') return b[key] as string;
  return null;
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
