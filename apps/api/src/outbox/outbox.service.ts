import { randomUUID } from 'node:crypto';
import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { AdminFailedJob, OutboxJobType } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { OutboxJobState, Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { backoff, MAX_ATTEMPTS } from './backoff.js';

export type { OutboxJobType } from '@hg/models';

/** A claimed job, as its handler sees it. `attempts` counts the failed runs before this one. */
export interface OutboxJobRow {
  id: string;
  type: OutboxJobType;
  dedupeKey: string;
  payload: unknown;
  attempts: number;
  orderId: string | null;
  createdAt: Date;
}

/** Runs one job. It may run more than once (a crash before DONE): it must be idempotent. Throwing retries it. */
export type OutboxHandler<P = unknown> = (payload: P, job: OutboxJobRow) => Promise<void>;

export interface OutboxJobInput {
  type: OutboxJobType;
  /** Unique per side effect (`invoice.issue:<orderId>`): enqueueing the same key again does nothing. */
  dedupeKey: string;
  payload: object;
  /** The order the job belongs to: its failed jobs flag the order for staff. */
  orderId?: string;
}

/** A RUNNING job not finished within this time is taken to have lost its worker (a crash) and runs again. */
export const STUCK_RUNNING_MS = 10 * 60_000;

const ERROR_MAX = 1000;
const FAILED_LIST_MAX = 200;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The columns are `timestamp` holding UTC (Prisma's convention), whatever the session time zone. */
const NOW = Prisma.sql`(now() AT TIME ZONE 'UTC')`;

interface ClaimedRow {
  id: string;
  type: string;
  dedupe_key: string;
  payload: unknown;
  attempts: number;
  order_id: string | null;
  created_at: Date;
}

/**
 * The durable outbox (spec §5.1, decision 83). A job is inserted in the transaction of the change that causes it
 * (`enqueue`), so it exists exactly when the change committed. `runDue` (called by `OutboxWorker`, or by tests)
 * claims due jobs with `FOR UPDATE SKIP LOCKED` — safe with several API processes — and runs their handlers outside
 * any transaction. Only types with a registered handler are claimed: a job enqueued before its handler exists waits.
 */
@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);
  private readonly handlers = new Map<OutboxJobType, OutboxHandler>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** Sets the handler of a job type (a second call replaces it). */
  register<P = unknown>(type: OutboxJobType, handler: OutboxHandler<P>): void {
    this.handlers.set(type, handler as OutboxHandler);
  }

  /** Inserts the job inside `tx`; a job with the same `dedupeKey` already there is kept as it is. */
  async enqueue(tx: Prisma.TransactionClient, job: OutboxJobInput): Promise<void> {
    await tx.$executeRaw`
      INSERT INTO outbox_jobs (id, type, dedupe_key, payload, order_id, run_after, created_at, updated_at)
      VALUES (${randomUUID()}::uuid, ${job.type}, ${job.dedupeKey}, ${JSON.stringify(job.payload)}::jsonb,
              ${job.orderId ?? null}::uuid, ${NOW}, ${NOW}, ${NOW})
      ON CONFLICT (dedupe_key) DO NOTHING`;
  }

  /**
   * Returns stuck RUNNING jobs to PENDING, then claims up to `limit` due PENDING jobs that have a handler (oldest due
   * first) and runs them one after another. Success → DONE; an error → PENDING again after `backoff(attempts)`, or
   * FAILED after `MAX_ATTEMPTS`. Returns how many jobs were claimed.
   */
  async runDue(limit = 10): Promise<number> {
    const types = [...this.handlers.keys()];
    if (types.length === 0) return 0;
    await this.reclaimStuck();
    const claimed = await this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE outbox_jobs SET state = 'running', updated_at = ${NOW}
      WHERE state = 'pending' AND id IN (
        SELECT id FROM outbox_jobs
        WHERE state = 'pending' AND run_after <= ${NOW} AND type IN (${Prisma.join(types)})
        ORDER BY run_after, created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED)
      RETURNING id, type, dedupe_key, payload, attempts, order_id, created_at`;
    for (const row of claimed)
      await this.run({
        id: row.id,
        type: row.type as OutboxJobType,
        dedupeKey: row.dedupe_key,
        payload: row.payload,
        attempts: row.attempts,
        orderId: row.order_id,
        createdAt: row.created_at,
      });
    return claimed.length;
  }

  /** A RUNNING job older than `STUCK_RUNNING_MS` lost its worker: it becomes PENDING (its attempts unchanged). */
  private async reclaimStuck(): Promise<void> {
    const reclaimed = await this.prisma.$executeRaw`
      UPDATE outbox_jobs
      SET state = 'pending', updated_at = ${NOW}, last_error = 'reclaimed: still running after 10 minutes'
      WHERE state = 'running' AND updated_at < ${NOW} - make_interval(secs => ${STUCK_RUNNING_MS / 1000})`;
    if (reclaimed > 0) this.logger.warn(`Reclaimed ${reclaimed} outbox job(s) stuck in RUNNING`);
  }

  private async run(job: OutboxJobRow): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for ${job.type}`);
      await handler(job.payload, job);
    } catch (error) {
      const attempts = job.attempts + 1;
      const failed = attempts >= MAX_ATTEMPTS;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, ERROR_MAX) || 'error';
      if (failed) this.logger.error(`Outbox job ${job.dedupeKey} failed after ${attempts} attempts`, error);
      else this.logger.warn(`Outbox job ${job.dedupeKey} failed (attempt ${attempts}): ${message}`);
      await this.finish(job.id, {
        state: failed ? OutboxJobState.FAILED : OutboxJobState.PENDING,
        attempts,
        runAfter: new Date(Date.now() + backoff(attempts)),
        lastError: message,
      });
      return;
    }
    await this.finish(job.id, { state: OutboxJobState.DONE, lastError: null });
  }

  /** Records the result, only while the job is still RUNNING. A failure here leaves it to be reclaimed. */
  private async finish(id: string, data: Prisma.OutboxJobUpdateManyMutationInput): Promise<void> {
    await this.prisma.outboxJob
      .updateMany({ where: { id, state: OutboxJobState.RUNNING }, data })
      .catch((error: unknown) => this.logger.error(`Could not record the result of outbox job ${id}`, error));
  }

  /** GET /api/admin/jobs/failed: the FAILED jobs, the latest first. */
  async listFailed(): Promise<AdminFailedJob[]> {
    const rows = await this.prisma.outboxJob.findMany({
      where: { state: OutboxJobState.FAILED },
      orderBy: [{ updatedAt: 'desc' }, { id: 'asc' }],
      take: FAILED_LIST_MAX,
      include: { order: { select: { number: true } } },
    });
    return rows.map((j) => ({
      id: j.id,
      type: j.type as OutboxJobType,
      orderNumber: j.order?.number ?? null,
      attempts: j.attempts,
      lastError: j.lastError,
      updatedAt: j.updatedAt.toISOString(),
    }));
  }

  /** POST /api/admin/jobs/:id/retry: a FAILED job runs again from the start (404 unknown, 409 `not_failed`). */
  async retry(id: string, actor: { adminId: number; ip?: string }): Promise<void> {
    if (!UUID.test(id)) throw notFound();
    await this.prisma.$transaction(async (tx) => {
      const [locked] = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM outbox_jobs WHERE id = ${id}::uuid FOR UPDATE`;
      if (!locked) throw notFound();
      const job = await tx.outboxJob.findUniqueOrThrow({ where: { id } });
      if (job.state !== OutboxJobState.FAILED) throw new ConflictException({ statusCode: 409, code: 'not_failed' });
      await tx.outboxJob.update({
        where: { id },
        data: { state: OutboxJobState.PENDING, attempts: 0, runAfter: new Date() },
      });
      await this.audit.record(
        {
          actorId: actor.adminId,
          action: 'job.retry',
          entityType: 'outbox_job',
          entityId: id,
          before: { type: job.type, dedupeKey: job.dedupeKey, state: 'failed', attempts: job.attempts },
          after: { state: 'pending', attempts: 0 },
          ip: actor.ip,
        },
        tx,
      );
    });
  }
}

const notFound = () => new NotFoundException({ statusCode: 404, code: 'not_found' });
