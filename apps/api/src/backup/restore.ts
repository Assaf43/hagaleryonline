import { GetObjectCommand, paginateListObjectsV2, type S3Client } from '@aws-sdk/client-s3';
import { createWriteStream } from 'node:fs';
import { access, chmod, constants, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { finished, pipeline } from 'node:stream/promises';
import pg from 'pg';
import { S3Storage } from '../media/s3-storage.js';
import {
  BackupRuns,
  backupReader,
  checkDbName,
  childEnv,
  decrypt,
  DETAIL_MAX,
  failureDetail,
  forcePathStyle,
  need,
  pgEnv,
  pgRestoreArgs,
  runChild,
  type Env,
} from './backup-common.js';
import type { CountsFile } from './backup-db.js';
import { compareCounts, quoteIdent, tableCounts } from './table-counts.js';

/**
 * Restore commands (spec 9b.5), run by hand with their own one-off environment (deploy/backup/README.md): never in
 * the server env. Nothing here prints a key, a URL with credentials or decrypted content; decrypted files live only in
 * a temp directory (mode 0700) that is removed in `finally`.
 */

const DUMP_KEY = /^db\/\d{4}-\d{2}-\d{2}\/nesto-[0-9TZ:.-]+\.dump\.age$/;

export interface RestoreDbOptions {
  object: string;
  identity: string;
  targetDb: string;
  keep?: boolean;
}

export interface RestoreDbResult {
  ok: boolean;
  /** One line per table whose count differs (empty when they all match). */
  mismatches: string[];
  tables: number;
  detail: string | null;
}

async function readableFile(path: string): Promise<void> {
  try {
    await access(path, constants.R_OK);
  } catch {
    throw new Error('the identity file cannot be read');
  }
}

function databaseOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.slice(1));
}

function withDatabase(url: string, database: string): string {
  const out = new URL(url);
  out.pathname = `/${database}`;
  return out.toString();
}

async function getBody(s3: S3Client, bucket: string, key: string, signal: AbortSignal): Promise<Readable> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }), { abortSignal: signal });
  return out.Body as Readable;
}

/** Downloads one object and decrypts it into a file (mode 0600). */
async function decryptToFile(
  s3: S3Client,
  bucket: string,
  key: string,
  identity: string,
  file: string,
  signal: AbortSignal,
): Promise<void> {
  const body = await getBody(s3, bucket, key, signal);
  const age = decrypt(body, identity, signal);
  await Promise.all([finished(body), age.done, pipeline(age.child.stdout!, createWriteStream(file, { mode: 0o600 }))]);
}

/** Downloads one object and decrypts it in memory (counts files, photos). */
async function decryptToBuffer(
  s3: S3Client,
  bucket: string,
  key: string,
  identity: string,
  signal: AbortSignal,
): Promise<Buffer> {
  const body = await getBody(s3, bucket, key, signal);
  const age = decrypt(body, identity, signal);
  const chunks: Buffer[] = [];
  age.child.stdout!.on('data', (chunk: Buffer) => chunks.push(chunk));
  await Promise.all([finished(body), age.done, finished(age.child.stdout!)]);
  return Buffer.concat(chunks);
}

/**
 * `restore-db`: refuses a target database that exists at all (empty or not), so every run creates its own target.
 * Then: download and decrypt the dump and its counts file, `CREATE DATABASE`, `pg_restore`, and compare the row count
 * of every table with the counts taken in the dump's snapshot: an exact match per table, otherwise every mismatch is
 * listed and the result is not ok. The target is dropped afterwards unless `keep`. With `RESTORE_RECORD_DATABASE_URL`
 * the outcome is written as a `backup_runs` row (kind restore_test).
 */
export async function restoreDb(env: Env, o: RestoreDbOptions): Promise<RestoreDbResult> {
  if (!DUMP_KEY.test(o.object)) throw new Error('--object must be a key like db/<date>/nesto-<ISO>.dump.age');
  const target = checkDbName(o.targetDb);
  await readableFile(o.identity);
  const adminUrl = need(env, 'RESTORE_ADMIN_DATABASE_URL');
  const recordUrl = env.RESTORE_RECORD_DATABASE_URL || undefined;
  const reserved = new Set(['postgres', 'template0', 'template1', databaseOf(adminUrl)]);
  if (recordUrl) reserved.add(databaseOf(recordUrl));
  if (reserved.has(target)) throw new Error(`refusing to restore into ${target}`);
  const { client: s3, bucket } = backupReader(env);

  const admin = new pg.Client({ connectionString: adminUrl, application_name: 'nesto-restore' });
  const targetUrl = withDatabase(adminUrl, target);
  let created = false;
  let runs: BackupRuns | null = null;
  let runId: number | null = null;
  let dir: string | null = null;
  const controller = new AbortController();
  let result: RestoreDbResult = { ok: false, mismatches: [], tables: 0, detail: null };
  try {
    await admin.connect();
    const exists = (await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [target])).rowCount;
    if (exists) throw new Error(`target database ${target} already exists: choose a new name (it is never reused)`);

    if (recordUrl) {
      runs = await BackupRuns.connect(recordUrl);
      runId = await runs.start('restore_test', new Date());
    }
    try {
      dir = await mkdtemp(join(tmpdir(), 'nesto-restore-'));
      await chmod(dir, 0o700);
      const dumpFile = join(dir, 'dump');
      await decryptToFile(s3, bucket, o.object, o.identity, dumpFile, controller.signal);
      const countsKey = o.object.replace(/\.dump\.age$/, '.counts.json.age');
      const countsText = (await decryptToBuffer(s3, bucket, countsKey, o.identity, controller.signal)).toString('utf8');
      let counts: CountsFile;
      try {
        counts = JSON.parse(countsText) as CountsFile;
      } catch {
        throw new Error('the counts file is not valid JSON');
      }
      if (
        typeof counts !== 'object' ||
        counts === null ||
        counts.format !== 1 ||
        typeof counts.tables !== 'object' ||
        counts.tables === null
      )
        throw new Error('the counts file is not in the expected format');

      await admin.query(`CREATE DATABASE ${quoteIdent(target)}`);
      created = true;
      await runChild(
        'pg_restore',
        pgRestoreArgs(target, dumpFile),
        childEnv(pgEnv(adminUrl, target)),
        controller.signal,
        'ignore',
      ).done;

      const restored = new pg.Client({ connectionString: targetUrl, application_name: 'nesto-restore' });
      await restored.connect();
      let actual: Record<string, number>;
      try {
        actual = await tableCounts(restored);
      } finally {
        await restored.end().catch(() => undefined);
      }
      const mismatches = compareCounts(counts.tables, actual);
      result = {
        ok: mismatches.length === 0,
        mismatches,
        tables: Object.keys(actual).length,
        detail: mismatches.length
          ? `row counts differ in ${mismatches.length} tables: ${mismatches.join('; ')}`.slice(0, DETAIL_MAX)
          : null,
      };
    } catch (error) {
      controller.abort();
      result = { ok: false, mismatches: [], tables: 0, detail: failureDetail(error) };
    }
    if (created && !o.keep) {
      try {
        await admin.query(`DROP DATABASE IF EXISTS ${quoteIdent(target)} WITH (FORCE)`);
      } catch (error) {
        result = {
          ...result,
          ok: false,
          detail: `could not drop ${target}: ${failureDetail(error)}`.slice(0, DETAIL_MAX),
        };
      }
    }
    if (runs && runId !== null) await runs.finish(runId, { ok: result.ok, detail: result.detail });
    return result;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
    await admin.end().catch(() => undefined);
    await runs?.close();
    s3.destroy();
  }
}

export interface RestoreMediaResult {
  ok: boolean;
  restored: number;
  skipped: number;
  failed: number;
  detail: string | null;
}

const MEDIA_KEY = /^media\/(public|private)\/(.+)\.age$/;

/**
 * `restore-media`: every backup object under `prefix` (default `media/`) is decrypted and put back into the media
 * bucket its prefix names, with the API's own content type and cache headers (S3Storage). Objects that exist are
 * skipped, so it can run again after a partial restore. Reads the backup bucket with the reader keys and writes the
 * media buckets with `RESTORE_S3_*` (the app user's keys).
 */
export async function restoreMedia(env: Env, o: { identity: string; prefix?: string }): Promise<RestoreMediaResult> {
  const prefix = o.prefix ?? 'media/';
  if (!prefix.startsWith('media/')) throw new Error('--prefix must start with media/');
  await readableFile(o.identity);
  const { client: s3, bucket } = backupReader(env);
  const storage = new S3Storage({
    endpoint: need(env, 'S3_ENDPOINT'),
    region: need(env, 'S3_REGION'),
    accessKeyId: need(env, 'RESTORE_S3_ACCESS_KEY_ID'),
    secretAccessKey: need(env, 'RESTORE_S3_SECRET_ACCESS_KEY'),
    publicBucket: need(env, 'S3_PUBLIC_BUCKET'),
    privateBucket: need(env, 'S3_PRIVATE_BUCKET'),
    forcePathStyle: forcePathStyle(env),
    urlPrefix: '/media',
  });
  const controller = new AbortController();
  let restored = 0;
  let skipped = 0;
  let failed = 0;
  let firstError: unknown;
  try {
    for await (const page of paginateListObjectsV2({ client: s3 }, { Bucket: bucket, Prefix: prefix })) {
      for (const object of page.Contents ?? []) {
        const match = object.Key ? MEDIA_KEY.exec(object.Key) : null;
        if (!match) {
          failed++;
          firstError ??= new Error('a backup object outside media/public/ or media/private/');
          continue;
        }
        const visibility = match[1] as 'public' | 'private';
        const key = match[2];
        try {
          if (await storage.exists(key, visibility)) {
            skipped++;
            continue;
          }
          const data = await decryptToBuffer(s3, bucket, object.Key!, o.identity, controller.signal);
          await storage.put(key, data, visibility);
          restored++;
        } catch (error) {
          failed++;
          firstError ??= error;
        }
      }
    }
  } finally {
    s3.destroy();
  }
  const detail = failed ? `${failed} objects failed: ${failureDetail(firstError)}` : null;
  return { ok: failed === 0, restored, skipped, failed, detail };
}
