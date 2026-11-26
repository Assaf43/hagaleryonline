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
  checkRoleName,
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

interface ForeignOwned {
  kind: string;
  name: string;
  owner: string;
}

const DUMP_KEY = /^db\/\d{4}-\d{2}-\d{2}\/nesto-[0-9TZ:.-]+\.dump\.age$/;

export interface RestoreDbOptions {
  object: string;
  identity: string;
  targetDb: string;
  keep?: boolean;
  /** `--owner`: a role name, or `none`; omitted = `DB_OWNER_ROLE`, else `nesto_owner` (see `restoreOwner`). */
  owner?: string;
}

export interface RestoreDbResult {
  ok: boolean;
  /** One line per table whose count differs (empty when they all match). */
  mismatches: string[];
  tables: number;
  detail: string | null;
  /** The role that owns the restored objects (null: `--owner none`, the restore admin owns them). */
  owner: string | null;
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

/**
 * The role that owns the restored database (spec 9b.5, the rehearsal's disaster drill): the same owner as the live
 * database (deploy/postgres/init/01-roles.sh), so the migrate service (`prisma migrate deploy && apply-db-grants`, as
 * that owner) can grant the app and backup roles on the restored database with no manual `ALTER … OWNER`. `none`
 * keeps everything owned by the admin role (a pure check against a cluster without the role).
 */
export function restoreOwner(env: Env, option?: string): string | null {
  const value = option ?? (env.DB_OWNER_ROLE || 'nesto_owner');
  if (value === 'none') return null;
  return checkRoleName(value);
}

/** `CREATE DATABASE "<target>" [OWNER "<owner>"]`; both names checked, then quoted. */
export function createDatabaseSql(target: string, owner: string | null): string {
  const create = `CREATE DATABASE ${quoteIdent(checkDbName(target))}`;
  return owner ? `${create} OWNER ${quoteIdent(checkRoleName(owner))}` : create;
}

/**
 * Run by the admin before pg_restore when there is an owner: the same privileges as a fresh database from
 * 01-roles.sh (nothing for PUBLIC; the app and backup roles get theirs from apply-db-grants). `cluster` runs on the
 * admin's own connection, `inTarget` inside the new database.
 */
export function ownerSetupSql(target: string, owner: string): { cluster: string[]; inTarget: string[] } {
  const role = quoteIdent(checkRoleName(owner));
  return {
    cluster: [`REVOKE ALL ON DATABASE ${quoteIdent(checkDbName(target))} FROM PUBLIC`],
    inTarget: [`ALTER SCHEMA public OWNER TO ${role}`, 'REVOKE ALL ON SCHEMA public FROM PUBLIC'],
  };
}

/** Whether the role exists, is a superuser, and whether the admin may `SET ROLE` to it (what `pg_restore --role` does). */
export const OWNER_ROLE_SQL = `SELECT r.rolsuper AS "super", pg_has_role(current_user, r.oid, 'SET') AS "canSet"
  FROM pg_catalog.pg_roles r WHERE r.rolname = $1`;

/**
 * Objects in `public` (and the database and schema themselves) not owned by $1 after the restore: tables, sequences,
 * views, functions, enums and domains. Members of an extension are left out: a trusted extension such as pg_trgm is
 * owned by the role that created it, but the functions and types inside it belong to the bootstrap superuser.
 */
export const FOREIGN_OWNED_SQL = `SELECT o.kind, o.name, pg_catalog.pg_get_userbyid(o.owner) AS owner FROM (
    SELECT 'database' AS kind, d.datname::text AS name, d.datdba AS owner, 'pg_database'::regclass AS cls, d.oid
      FROM pg_catalog.pg_database d WHERE d.datname = current_database()
    UNION ALL
    SELECT 'schema', n.nspname::text, n.nspowner, 'pg_namespace'::regclass, n.oid
      FROM pg_catalog.pg_namespace n WHERE n.nspname = 'public'
    UNION ALL
    SELECT CASE c.relkind WHEN 'S' THEN 'sequence' WHEN 'v' THEN 'view' WHEN 'm' THEN 'view' ELSE 'table' END,
           c.relname::text, c.relowner, 'pg_class'::regclass, c.oid
      FROM pg_catalog.pg_class c
     WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'S', 'v', 'm', 'f')
    UNION ALL
    SELECT 'function', p.proname::text, p.proowner, 'pg_proc'::regclass, p.oid
      FROM pg_catalog.pg_proc p WHERE p.pronamespace = 'public'::regnamespace
    UNION ALL
    SELECT 'type', t.typname::text, t.typowner, 'pg_type'::regclass, t.oid
      FROM pg_catalog.pg_type t WHERE t.typnamespace = 'public'::regnamespace AND t.typtype IN ('e', 'd')
  ) o
  WHERE o.owner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = $1)
    AND NOT EXISTS (SELECT 1 FROM pg_catalog.pg_depend e WHERE e.classid = o.cls AND e.objid = o.oid AND e.deptype = 'e')
  ORDER BY o.kind, o.name`;

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
 *
 * With an owner (the default, `restoreOwner`) the target is created `OWNER <owner>`, its schema `public` is given to
 * the owner, and pg_restore runs with `--role=<owner>`, so every restored object is the owner's; afterwards any
 * object in `public` owned by someone else fails the restore. The admin must be able to `SET ROLE` to the owner
 * (the superuser can); a missing role, one it cannot become, or a superuser owner is refused before anything starts.
 */
export async function restoreDb(env: Env, o: RestoreDbOptions): Promise<RestoreDbResult> {
  if (!DUMP_KEY.test(o.object)) throw new Error('--object must be a key like db/<date>/nesto-<ISO>.dump.age');
  const target = checkDbName(o.targetDb);
  const owner = restoreOwner(env, o.owner);
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
  let result: RestoreDbResult = { ok: false, mismatches: [], tables: 0, detail: null, owner };
  try {
    await admin.connect();
    const exists = (await admin.query('SELECT 1 FROM pg_catalog.pg_database WHERE datname = $1', [target])).rowCount;
    if (exists) throw new Error(`target database ${target} already exists: choose a new name (it is never reused)`);
    if (owner) {
      const role = (await admin.query<{ super: boolean; canSet: boolean }>(OWNER_ROLE_SQL, [owner])).rows[0];
      if (!role)
        throw new Error(`owner role ${owner} does not exist (--owner <role>, or --owner none for a pure check)`);
      if (role.super) throw new Error(`owner role ${owner} is a superuser: use --owner none instead`);
      if (!role.canSet)
        throw new Error(`the restore admin cannot SET ROLE ${owner}: run it as the superuser or a member of ${owner}`);
    }

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

      await admin.query(createDatabaseSql(target, owner));
      created = true;
      if (owner) {
        const setup = ownerSetupSql(target, owner);
        for (const sql of setup.cluster) await admin.query(sql);
        const fresh = new pg.Client({ connectionString: targetUrl, application_name: 'nesto-restore' });
        await fresh.connect();
        try {
          for (const sql of setup.inTarget) await fresh.query(sql);
        } finally {
          await fresh.end().catch(() => undefined);
        }
      }
      await runChild(
        'pg_restore',
        pgRestoreArgs(target, dumpFile, owner),
        childEnv(pgEnv(adminUrl, target)),
        controller.signal,
        'ignore',
      ).done;

      const restored = new pg.Client({ connectionString: targetUrl, application_name: 'nesto-restore' });
      await restored.connect();
      let actual: Record<string, number>;
      let foreign: ForeignOwned[] = [];
      try {
        actual = await tableCounts(restored);
        if (owner) foreign = (await restored.query<ForeignOwned>(FOREIGN_OWNED_SQL, [owner])).rows;
      } finally {
        await restored.end().catch(() => undefined);
      }
      if (foreign.length)
        throw new Error(
          `${foreign.length} objects not owned by ${owner} after the restore: ` +
            foreign.map((f) => `${f.kind} ${f.name} (${f.owner})`).join('; '),
        );
      const mismatches = compareCounts(counts.tables, actual);
      result = {
        owner,
        ok: mismatches.length === 0,
        mismatches,
        tables: Object.keys(actual).length,
        detail: mismatches.length
          ? `row counts differ in ${mismatches.length} tables: ${mismatches.join('; ')}`.slice(0, DETAIL_MAX)
          : null,
      };
    } catch (error) {
      controller.abort();
      result = { ok: false, mismatches: [], tables: 0, detail: failureDetail(error), owner };
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
