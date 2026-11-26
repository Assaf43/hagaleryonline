import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service.js';
import { fingerprint } from './fingerprint.js';
import { scrub, stripQuery } from './scrub.js';

export type ErrorEventKind = 'error' | 'warn';
export type ErrorEventSource = 'api' | 'ssr';

/** One logged error or warning, as `AppLogger` (and the SSR log endpoint) hands it over. */
export interface CapturedEvent {
  kind: ErrorEventKind;
  source: ErrorEventSource;
  message: string;
  stack?: string;
  /** The request path; any query string is cut off again here. */
  path?: string;
}

/** A group that the last flush created or reopened (the alerts read these). */
export interface ErrorGroupChange {
  id: number;
  fingerprint: string;
  kind: ErrorEventKind;
  source: ErrorEventSource;
  /** Scrubbed. */
  message: string;
  path: string | null;
  /** The group's total count after the flush. */
  count: number;
  isNew: boolean;
  reopened: boolean;
}

interface PendingGroup {
  fingerprint: string;
  kind: ErrorEventKind;
  source: ErrorEventSource;
  message: string;
  stack: string | null;
  path: string | null;
  count: number;
  firstSeen: Date;
  lastSeen: Date;
}

interface UpsertRow {
  id: number;
  fingerprint: string;
  kind: ErrorEventKind;
  source: ErrorEventSource;
  message: string;
  path: string | null;
  count: number;
  inserted: boolean;
  reopened: boolean;
}

/** New keys beyond this many in one flush window go to the overflow group. */
export const MAX_PENDING_GROUPS = 500;
export const FLUSH_EVERY_MS = 5_000;
const CLEANUP_EVERY_MS = 24 * 60 * 60_000;
/** Groups not seen for this long are deleted (spec 9b.6). */
export const ERROR_EVENT_RETENTION_MS = 30 * 24 * 60 * 60_000;
/** Stack lines kept: the frames after the message lines. */
export const MAX_STACK_FRAMES = 10;
const MAX_PATH_LENGTH = 500;

const OVERFLOW_MESSAGE = `Error events: more than ${MAX_PENDING_GROUPS} new groups in ${FLUSH_EVERY_MS / 1000} s, the rest are counted here`;

/** The message lines of a stack and its first {@link MAX_STACK_FRAMES} `at …` frames. */
export function topFrames(stack: string): string {
  const out: string[] = [];
  let frames = 0;
  for (const line of stack.split(/\r?\n/)) {
    if (/^\s*at\s/.test(line) && ++frames > MAX_STACK_FRAMES) break;
    out.push(line);
  }
  return out.join('\n');
}

/** Never prints through a logger: a failure here must not be captured again (no recursion, spec 9b.6). */
function printFailure(what: string, error: unknown): void {
  const code = error instanceof Error ? error.name : typeof error;
  try {
    process.stderr.write(`error_events: ${what} failed (${code})\n`);
  } catch {
    // Nothing left to tell.
  }
}

/**
 * Errors and warnings grouped by fingerprint (spec 9b.6, NFR-11). `capture` only counts in memory; `flush` (every 5 s
 * and on shutdown) writes one upsert per group, and `cleanup` (daily) deletes groups not seen for 30 days. With the
 * database down a batch is dropped after one stderr line: recording never blocks a request or loops. Nothing here
 * logs through `AppLogger`, so its own failures are never captured. `ERROR_EVENTS_WORKER=off` keeps the timers off
 * (the e2e tests flush themselves); the flush on shutdown still runs.
 */
@Injectable()
export class ErrorEventsService implements OnModuleInit, OnModuleDestroy {
  private pending = new Map<string, PendingGroup>();
  private overflow: PendingGroup | undefined;
  private flushTimer: NodeJS.Timeout | undefined;
  private cleanupTimer: NodeJS.Timeout | undefined;
  private readonly flushListeners: ((changes: ErrorGroupChange[]) => Promise<void> | void)[] = [];

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('ERROR_EVENTS_WORKER') === 'off') return;
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_EVERY_MS).unref();
    const cleanup = () => this.cleanup().catch((error: unknown) => printFailure('cleanup', error));
    void cleanup();
    this.cleanupTimer = setInterval(() => void cleanup(), CLEANUP_EVERY_MS).unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.flushTimer);
    clearInterval(this.cleanupTimer);
    await this.flush();
  }

  /**
   * Registers a listener that gets the new or reopened groups of each flush that has any (the alerts, spec 9b.6).
   * A listener that throws is reported on stderr only; it never breaks the flush. The events service knows nothing
   * of the outbox: the listener's owner brings it.
   */
  onFlush(listener: (changes: ErrorGroupChange[]) => Promise<void> | void): void {
    this.flushListeners.push(listener);
  }

  /** Counts one event under its group. Synchronous and never throws. */
  capture(e: CapturedEvent): void {
    try {
      const now = new Date();
      const rawMessage = typeof e.message === 'string' ? e.message : String(e.message);
      const rawStack = typeof e.stack === 'string' ? e.stack : undefined;
      const key = fingerprint({ kind: e.kind, source: e.source, message: rawMessage, stack: rawStack });
      const group = this.pending.get(key);
      const sample = {
        message: scrub(rawMessage) || '(empty)',
        stack: rawStack ? scrub(topFrames(rawStack)) : null,
        path: typeof e.path === 'string' ? scrub(stripQuery(e.path)).slice(0, MAX_PATH_LENGTH) : null,
      };
      if (group) {
        group.message = sample.message;
        group.stack = sample.stack ?? group.stack;
        group.path = sample.path ?? group.path;
        group.count += 1;
        group.lastSeen = now;
        return;
      }
      if (this.pending.size < MAX_PENDING_GROUPS) {
        this.pending.set(key, {
          fingerprint: key,
          kind: e.kind,
          source: e.source,
          ...sample,
          count: 1,
          firstSeen: now,
          lastSeen: now,
        });
        return;
      }
      if (this.overflow) {
        this.overflow.count += 1;
        this.overflow.lastSeen = now;
        return;
      }
      this.overflow = {
        fingerprint: fingerprint({ kind: 'warn', source: 'api', message: OVERFLOW_MESSAGE }),
        kind: 'warn',
        source: 'api',
        message: OVERFLOW_MESSAGE,
        stack: null,
        path: null,
        count: 1,
        firstSeen: now,
        lastSeen: now,
      };
    } catch {
      // Recording an error must never raise one.
    }
  }

  /**
   * Writes the pending groups, one upsert each, and returns the groups that are new or were reopened (a handled
   * group seen again). On a database error the rest of the batch is dropped after one stderr line; the groups
   * written before it are still returned. Never rejects.
   */
  async flush(): Promise<ErrorGroupChange[]> {
    const batch = [...this.pending.values()];
    if (this.overflow) batch.push(this.overflow);
    this.pending = new Map();
    this.overflow = undefined;
    const changes: ErrorGroupChange[] = [];
    try {
      for (const group of batch) {
        const [row] = await this.upsert(group);
        if (row && (row.inserted || row.reopened))
          changes.push({
            id: row.id,
            fingerprint: row.fingerprint,
            kind: row.kind,
            source: row.source,
            message: row.message,
            path: row.path,
            count: row.count,
            isNew: row.inserted,
            reopened: row.reopened,
          });
      }
    } catch (error) {
      printFailure(`flush of ${batch.length} group(s)`, error);
    }
    if (changes.length)
      for (const listener of this.flushListeners) {
        try {
          await listener(changes);
        } catch (error) {
          printFailure('flush listener', error);
        }
      }
    return changes;
  }

  /** Deletes groups last seen more than 30 days before `now`; returns how many. */
  async cleanup(now = new Date()): Promise<number> {
    const before = new Date(now.getTime() - ERROR_EVENT_RETENTION_MS);
    const { count } = await this.prisma.errorEvent.deleteMany({ where: { lastSeen: { lt: before } } });
    return count;
  }

  /**
   * Adds the count, keeps the latest sample, and reopens a handled group (`reopened_at` now, `handled_at` cleared).
   * `old` in RETURNING (PostgreSQL 18) tells a new row and a reopened one apart exactly. Timestamps are UTC like
   * every Prisma `DateTime` column (`timestamp` without time zone).
   */
  private upsert(g: PendingGroup): Promise<UpsertRow[]> {
    return this.prisma.$queryRaw<UpsertRow[]>`
      INSERT INTO error_events AS e (fingerprint, kind, source, message, stack, path, count, first_seen, last_seen)
      VALUES (${g.fingerprint}, ${g.kind}::error_event_kind, ${g.source}::error_event_source, ${g.message},
              ${g.stack}, ${g.path}, ${g.count}, ${g.firstSeen}, ${g.lastSeen})
      ON CONFLICT (fingerprint) DO UPDATE SET
        count = e.count + EXCLUDED.count,
        last_seen = GREATEST(e.last_seen, EXCLUDED.last_seen),
        message = EXCLUDED.message,
        stack = COALESCE(EXCLUDED.stack, e.stack),
        path = COALESCE(EXCLUDED.path, e.path),
        reopened_at = CASE WHEN e.handled_at IS NULL THEN e.reopened_at ELSE (now() AT TIME ZONE 'UTC') END,
        handled_at = NULL
      RETURNING e.id, e.fingerprint, e.kind::text AS kind, e.source::text AS source, e.message, e.path, e.count,
        (old.id IS NULL) AS inserted, (old.handled_at IS NOT NULL) AS reopened`;
  }
}
