import { statfs } from 'node:fs/promises';
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ERROR_GROUP_STATES,
  ERROR_GROUPS_PAGE_SIZE,
  type BackupKindView,
  type BackupRunView,
  type ErrorGroupDetail,
  type ErrorGroupPage,
  type ErrorGroupState,
  type ErrorGroupView,
  type SystemStatus,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { BackupKind, type BackupRun, type ErrorEvent, type Prisma } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

const DAY_MS = 24 * 60 * 60_000;
/** A restore test older than this is stale (a monthly restore test, with a few days of slack). */
export const RESTORE_TEST_MAX_AGE_DAYS = 35;

const KIND_VIEW: Record<BackupKind, BackupKindView> = {
  DB: 'db',
  MEDIA: 'media',
  RESTORE_TEST: 'restore_test',
};

const invalidInput = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });
const notFound = () => new NotFoundException({ statusCode: 404, code: 'not_found' });

export interface ErrorGroupFilter {
  state: ErrorGroupState;
  page: number;
}

/** `?state=` (default open) and `?page=` (default 1, a positive integer). */
export function parseErrorGroupFilter(query: { state?: unknown; page?: unknown }): ErrorGroupFilter {
  let state: ErrorGroupState = 'open';
  if (query.state !== undefined) {
    if (typeof query.state !== 'string' || !(ERROR_GROUP_STATES as readonly string[]).includes(query.state))
      throw invalidInput('state');
    state = query.state as ErrorGroupState;
  }
  let page = 1;
  if (query.page !== undefined) {
    if (typeof query.page !== 'string' || !/^\d{1,6}$/.test(query.page) || Number(query.page) < 1)
      throw invalidInput('page');
    page = Number(query.page);
  }
  return { state, page };
}

/** An error group id from the URL: a positive int4, anything else is "not found". */
export function parseErrorGroupId(value: string): number | null {
  if (!/^\d{1,10}$/.test(value)) return null;
  const n = Number(value);
  return n >= 1 && n <= 2_147_483_647 ? n : null;
}

function backupView(r: BackupRun): BackupRunView {
  return {
    kind: KIND_VIEW[r.kind],
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    ok: r.ok,
    bytes: r.bytes === null ? null : Number(r.bytes),
    objects: r.objects,
    detail: r.detail,
  };
}

function groupView(e: ErrorEvent): ErrorGroupView {
  return {
    id: e.id,
    kind: e.kind === 'ERROR' ? 'error' : 'warn',
    source: e.source === 'API' ? 'api' : 'ssr',
    message: e.message,
    path: e.path,
    count: e.count,
    firstSeen: e.firstSeen.toISOString(),
    lastSeen: e.lastSeen.toISOString(),
    handledAt: e.handledAt?.toISOString() ?? null,
    reopenedAt: e.reopenedAt?.toISOString() ?? null,
  };
}

/** What the admin "תקלות ומצב המערכת" screen reads (spec 9b.6): the status panel and the error groups. */
@Injectable()
export class SystemStatusService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
  ) {}

  async status(now = new Date()): Promise<SystemStatus> {
    let db: SystemStatus['db'] = 'up';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      db = 'down';
    }
    // With the database down the backup rows and the failed-jobs count cannot be read: no rows, 0 jobs.
    const fromDb = db === 'up' ? await this.fromDatabase(now).catch(() => null) : null;
    return {
      db,
      ...(await this.disk()),
      failedJobs: fromDb?.failedJobs ?? 0,
      lastBackup: { db: fromDb?.db ?? null, media: fromDb?.media ?? null },
      lastRestoreTest: fromDb?.restoreTest ?? null,
      restoreTestStale: fromDb?.restoreTestStale ?? false,
      version: process.env.APP_VERSION?.trim() || 'dev',
      uptimeSeconds: Math.floor(process.uptime()),
    };
  }

  private async fromDatabase(now: Date) {
    const latest = (kind: BackupKind) =>
      this.prisma.backupRun.findFirst({ where: { kind }, orderBy: { startedAt: 'desc' } });
    const latestOk = (kind: BackupKind) =>
      this.prisma.backupRun.findFirst({ where: { kind, ok: true }, orderBy: { startedAt: 'desc' } });
    const [failedJobs, db, media, restoreTest, okDb, okRestore] = await Promise.all([
      this.outbox.countFailed(),
      latest(BackupKind.DB),
      latest(BackupKind.MEDIA),
      latest(BackupKind.RESTORE_TEST),
      latestOk(BackupKind.DB),
      latestOk(BackupKind.RESTORE_TEST),
    ]);
    // Stale: a successful DB backup exists (there is something to restore) and the newest successful restore test
    // is missing or older than 35 days. With no DB backup at all nothing is stale: the backup rows say so already.
    const restoreTestStale =
      okDb !== null &&
      (okRestore === null || now.getTime() - okRestore.startedAt.getTime() > RESTORE_TEST_MAX_AGE_DAYS * DAY_MS);
    return {
      failedJobs,
      db: db && backupView(db),
      media: media && backupView(media),
      restoreTest: restoreTest && backupView(restoreTest),
      restoreTestStale,
    };
  }

  /** Free and total bytes of the disk the app runs on; null when the platform cannot say. */
  private async disk(): Promise<Pick<SystemStatus, 'diskFreeBytes' | 'diskTotalBytes'>> {
    try {
      const s = await statfs('/');
      return { diskFreeBytes: Number(s.bavail) * Number(s.bsize), diskTotalBytes: Number(s.blocks) * Number(s.bsize) };
    } catch {
      return { diskFreeBytes: null, diskTotalBytes: null };
    }
  }

  async listErrors(filter: ErrorGroupFilter): Promise<ErrorGroupPage> {
    const where: Prisma.ErrorEventWhereInput =
      filter.state === 'open' ? { handledAt: null } : filter.state === 'handled' ? { handledAt: { not: null } } : {};
    const [total, rows] = await Promise.all([
      this.prisma.errorEvent.count({ where }),
      this.prisma.errorEvent.findMany({
        where,
        orderBy: [{ lastSeen: 'desc' }, { id: 'desc' }],
        skip: (filter.page - 1) * ERROR_GROUPS_PAGE_SIZE,
        take: ERROR_GROUPS_PAGE_SIZE,
      }),
    ]);
    return { items: rows.map(groupView), total, page: filter.page, pageSize: ERROR_GROUPS_PAGE_SIZE };
  }

  async errorDetail(idParam: string): Promise<ErrorGroupDetail> {
    const id = parseErrorGroupId(idParam);
    const row =
      id === null ? null : await this.prisma.errorEvent.findUnique({ where: { id }, include: { handledBy: true } });
    if (!row) throw notFound();
    return {
      ...groupView(row),
      stack: row.stack,
      // The column outlives a reopen, but a reopened group is not "handled by" anyone now.
      handledBy: row.handledAt ? (row.handledBy?.name ?? null) : null,
    };
  }

  /** Marks a group handled. Already handled: nothing changes and nothing is audited (idempotent, 204 either way). */
  async markHandled(idParam: string, actor: { actorId: number; ip?: string | null }): Promise<void> {
    const id = parseErrorGroupId(idParam);
    if (id === null) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      const handledAt = new Date();
      // Only an open group is updated, so two clicks race to one winner and one audit row.
      const { count } = await tx.errorEvent.updateMany({
        where: { id, handledAt: null },
        data: { handledAt, handledById: actor.actorId },
      });
      if (count === 0) {
        if (!(await tx.errorEvent.findUnique({ where: { id }, select: { id: true } }))) throw notFound();
        return;
      }
      await this.audit.record(
        {
          ...actor,
          action: 'system.error_handled',
          entityType: 'error_event',
          entityId: id,
          before: { handledAt: null },
          after: { handledAt: handledAt.toISOString() },
        },
        tx,
      );
    });
  }
}
