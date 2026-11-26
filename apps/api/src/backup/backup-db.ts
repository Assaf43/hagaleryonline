import { Readable } from 'node:stream';
import pg from 'pg';
import {
  BackupRuns,
  backupWriter,
  checkRecipient,
  childEnv,
  dumpKeys,
  encryptToBucket,
  failureDetail,
  need,
  pgDumpArgs,
  pgEnv,
  runChild,
  type Child,
  type Env,
} from './backup-common.js';
import { tableCounts } from './table-counts.js';

export interface BackupResult {
  ok: boolean;
  runId: number;
  bytes: number;
  objects: number;
  detail: string | null;
  key?: string;
}

/** The counts file next to each dump (encrypted the same way). */
export interface CountsFile {
  format: 1;
  dump: string;
  takenAt: string;
  tables: Record<string, number>;
}

/** Throws on a missing or bad setting before anything runs (the daemon checks this at start). */
export function dbBackupConfig(env: Env): void {
  need(env, 'BACKUP_DATABASE_URL');
  checkRecipient(need(env, 'BACKUP_AGE_RECIPIENT'));
  backupWriter(env).client.destroy();
}

/**
 * The nightly database backup (spec 9b.5). A `backup_runs` row (kind db) is written first; then one connection holds
 * a `REPEATABLE READ READ ONLY` transaction with an exported snapshot while `pg_dump --snapshot` runs, so the dump and
 * the row counts read in that transaction are the same state. A plain `pg` client (already a dependency through
 * `@prisma/adapter-pg`) rather than a Prisma interactive transaction: those have a timeout, and the snapshot must stay
 * open for as long as the dump takes. pg_dump → age → the backup bucket; then the counts file; then the row is closed.
 * A failure never throws past the row: it is `ok = false` with a scrubbed one-line detail.
 */
export async function runDbBackup(env: Env, opts: { signal?: AbortSignal } = {}): Promise<BackupResult> {
  const url = need(env, 'BACKUP_DATABASE_URL');
  const recipient = checkRecipient(need(env, 'BACKUP_AGE_RECIPIENT'));
  const { client: s3, bucket } = backupWriter(env);
  let runs: BackupRuns | null = null;
  const startedAt = new Date();
  const keys = dumpKeys(startedAt);
  let runId = 0;
  const db = new pg.Client({ connectionString: url, application_name: 'nesto-backup-snapshot' });
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  let dump: Child | null = null;
  try {
    runs = await BackupRuns.connect(url);
    runId = await runs.start('db', startedAt);
    let bytes = 0;
    try {
      await db.connect();
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const { rows } = await db.query<{ snapshot: string }>('SELECT pg_export_snapshot() AS snapshot');
      const tables = await tableCounts(db);

      dump = runChild('pg_dump', pgDumpArgs(rows[0].snapshot), childEnv(pgEnv(url)), controller.signal, 'ignore');
      bytes = await encryptToBucket({
        source: dump.child.stdout!,
        sourceDone: dump.done,
        recipient,
        client: s3,
        bucket,
        key: keys.dump,
        signal: controller.signal,
      });

      const counts: CountsFile = { format: 1, dump: keys.dump, takenAt: startedAt.toISOString(), tables };
      await encryptToBucket({
        source: Readable.from([Buffer.from(JSON.stringify(counts))]),
        sourceDone: Promise.resolve(),
        recipient,
        client: s3,
        bucket,
        key: keys.counts,
        signal: controller.signal,
      });
      await db.query('COMMIT');
    } catch (error) {
      // pg_dump never outlives a failed run.
      controller.abort();
      await dump?.done.catch(() => undefined);
      const detail = failureDetail(error);
      await runs.finish(runId, { ok: false, detail });
      return { ok: false, runId, bytes: 0, objects: 0, detail };
    }
    await runs.finish(runId, { ok: true, bytes, objects: 2 });
    return { ok: true, runId, bytes, objects: 2, detail: null, key: keys.dump };
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    await db.end().catch(() => undefined);
    await runs?.close();
    s3.destroy();
  }
}
