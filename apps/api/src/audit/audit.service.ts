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
    const userIds = [
      ...new Set(rows.filter((r) => r.entityType === 'admin_user' && r.entityId).map((r) => Number(r.entityId))),
    ];
    const names = new Map(
      (await this.prisma.adminUser.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })).map(
        (u) => [String(u.id), u.name],
      ),
    );
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
        entityLabel: r.entityType === 'admin_user' && r.entityId ? (names.get(r.entityId) ?? null) : null,
        before: r.before,
        after: r.after,
      })),
    };
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const { count } = await this.prisma.auditLog.deleteMany({
      where: { createdAt: { lt: new Date(now.getTime() - AUDIT_RETENTION_MS) } },
    });
    if (count) this.logger.log(`Purged ${count} audit entries older than two years`);
    return count;
  }
}

function toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === undefined || value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}
