import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BackupKind } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { ErrorEventsService, type ErrorGroupChange } from './error-events.service.js';
import { scrub } from './scrub.js';

export type SystemAlertReason = 'new_error' | 'reopened_error' | 'backup_failed' | 'backup_missing' | 'error_storm';

/** The `email.system_alert` job payload. No recipient: the handler reads `ALERT_EMAIL` when it sends. */
export interface SystemAlertPayload {
  reason: SystemAlertReason;
  /** Scrubbed message of the group, or the backup kind; never a path with a query. */
  summary: string;
  /** ISO time of the event. */
  at: string;
}

export const CHECK_BACKUPS_EVERY_MS = 5 * 60_000;
/** No successful database backup for this long raises the "missing" alert (spec 9b.6). */
export const BACKUP_MAX_AGE_MS = 26 * 60 * 60_000;
/** A failed backup run older than this never sends mail (a restored database, or a run from before `ALERT_EMAIL`). */
export const FAILED_RUN_ALERT_WINDOW_MS = 7 * 24 * 60 * 60_000;
const WATCH_MARK = 'backup_watch_since';
export const SUMMARY_MAX_LENGTH = 300;
const FAILED_RUNS_PER_CHECK = 20;
/** Alert budget (in memory, one API process): beyond it one storm summary replaces the single alerts. */
export const MAX_GROUP_ALERTS_PER_FLUSH = 5;
export const MAX_GROUP_ALERTS_PER_HOUR = 20;

/** Alert failures print one plain line and never go through `AppLogger`: they must not create a new error group. */
function printFailure(what: string, error: unknown): void {
  const code = error instanceof Error ? error.name : typeof error;
  try {
    process.stderr.write(`system_alerts: ${what} failed (${code})\n`);
  } catch {
    // Nothing left to tell.
  }
}

/**
 * Alert e-mails through the outbox (spec 9b.6): a new or reopened `error` group after each `ErrorEventsService`
 * flush (registered as its flush listener, so the events service never depends on the outbox), failed backup rows,
 * and a missing database backup. The job and `alertedAt` are written in one transaction; the outbox dedupe key
 * (`system_alert:<fingerprint>:<UTC hour>`, `…:backup_failed:<run id>`, `…:backup_missing:<UTC date>`) keeps it to
 * one e-mail per group per hour. With no `ALERT_EMAIL` nothing is enqueued and nothing is marked alerted.
 * `ERROR_EVENTS_WORKER=off` also keeps the backup check timer off (the e2e tests call `checkBackups()`).
 */
@Injectable()
export class SystemAlertsService implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | undefined;
  private budgetHour = '';
  private budgetUsed = 0;
  /** Overridable in tests. */
  now: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly config: ConfigService,
    private readonly events: ErrorEventsService,
  ) {}

  onModuleInit(): void {
    this.events.onFlush((changes) => this.afterFlush(changes));
    if (this.config.get<string>('ERROR_EVENTS_WORKER') === 'off') return;
    this.timer = setInterval(() => void this.checkBackups(), CHECK_BACKUPS_EVERY_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  private enabled(): boolean {
    return Boolean(this.config.get<string>('ALERT_EMAIL')?.trim());
  }

  /**
   * One alert per new or reopened `error` group of a flush (`warn` never), within the budget of 5 per flush and 20 per
   * UTC hour. Past it the groups keep `alertedAt` null and one `error_storm` alert (once per UTC hour) says how many
   * were not sent separately. Never rejects.
   */
  async afterFlush(changes: ErrorGroupChange[]): Promise<void> {
    if (!this.enabled()) return;
    const now = this.now();
    const hour = now.toISOString().slice(0, 13);
    if (this.budgetHour !== hour) {
      this.budgetHour = hour;
      this.budgetUsed = 0;
    }
    let sentInFlush = 0;
    let skipped = 0;
    for (const change of changes) {
      if (change.kind !== 'error' || !(change.isNew || change.reopened)) continue;
      if (sentInFlush >= MAX_GROUP_ALERTS_PER_FLUSH || this.budgetUsed >= MAX_GROUP_ALERTS_PER_HOUR) {
        skipped += 1;
        continue;
      }
      sentInFlush += 1;
      this.budgetUsed += 1;
      try {
        const payload: SystemAlertPayload = {
          reason: change.isNew ? 'new_error' : 'reopened_error',
          summary: scrub(change.message).slice(0, SUMMARY_MAX_LENGTH),
          at: now.toISOString(),
        };
        await this.prisma.$transaction(async (tx) => {
          await this.outbox.enqueue(tx, {
            type: 'email.system_alert',
            dedupeKey: `system_alert:${change.fingerprint}:${hour}`,
            payload,
          });
          await tx.errorEvent.update({ where: { id: change.id }, data: { alertedAt: now } });
        });
      } catch (error) {
        printFailure('error alert', error);
      }
    }
    if (skipped === 0) return;
    try {
      const payload: SystemAlertPayload = { reason: 'error_storm', summary: String(skipped), at: now.toISOString() };
      await this.prisma.$transaction((tx) =>
        this.outbox.enqueue(tx, { type: 'email.system_alert', dedupeKey: `system_alert:storm:${hour}`, payload }),
      );
    } catch (error) {
      printFailure('storm alert', error);
    }
  }

  /** Failed backup rows not alerted yet, then the missing-backup check. Never rejects. */
  async checkBackups(): Promise<void> {
    if (!this.enabled()) return;
    const now = this.now();
    const windowStart = new Date(now.getTime() - FAILED_RUN_ALERT_WINDOW_MS);
    try {
      const failed = await this.prisma.backupRun.findMany({
        where: {
          ok: false,
          alertedAt: null,
          OR: [{ finishedAt: { gte: windowStart } }, { finishedAt: null, startedAt: { gte: windowStart } }],
        },
        select: { id: true, kind: true },
        orderBy: { id: 'asc' },
        take: FAILED_RUNS_PER_CHECK,
      });
      for (const run of failed) {
        const payload: SystemAlertPayload = {
          reason: 'backup_failed',
          summary: run.kind.toLowerCase(),
          at: now.toISOString(),
        };
        await this.prisma.$transaction(async (tx) => {
          await this.outbox.enqueue(tx, {
            type: 'email.system_alert',
            dedupeKey: `system_alert:backup_failed:${run.id}`,
            payload,
          });
          await tx.backupRun.update({ where: { id: run.id }, data: { alertedAt: now } });
        });
      }
    } catch (error) {
      printFailure('backup failure alert', error);
    }
    if (this.config.get<string>('BACKUP_EXPECTED') !== 'true') return;
    try {
      const last = await this.prisma.backupRun.findFirst({
        where: { kind: BackupKind.DB, ok: true, finishedAt: { not: null } },
        orderBy: { finishedAt: 'desc' },
        select: { finishedAt: true },
      });
      // Without any success, the clock starts at the first check ever (a persisted mark, so an API restart does not
      // reset it): a fresh install is not "late" yet.
      const since = last?.finishedAt ?? (await this.watchSince(now));
      if (now.getTime() - since.getTime() < BACKUP_MAX_AGE_MS) return;
      const payload: SystemAlertPayload = { reason: 'backup_missing', summary: 'db', at: now.toISOString() };
      await this.prisma.$transaction((tx) =>
        this.outbox.enqueue(tx, {
          type: 'email.system_alert',
          dedupeKey: `system_alert:backup_missing:${now.toISOString().slice(0, 10)}`,
          payload,
        }),
      );
    } catch (error) {
      printFailure('missing backup alert', error);
    }
  }

  /** The persisted start of the "no backup yet" clock: written once, then only read. */
  private async watchSince(now: Date): Promise<Date> {
    await this.prisma
      .$executeRaw`INSERT INTO system_marks (key, at) VALUES (${WATCH_MARK}, ${now}) ON CONFLICT (key) DO NOTHING`;
    const mark = await this.prisma.systemMark.findUnique({ where: { key: WATCH_MARK } });
    return mark?.at ?? now;
  }
}
