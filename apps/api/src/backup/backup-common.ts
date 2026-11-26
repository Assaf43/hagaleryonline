import { spawn, type ChildProcess } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import pg from 'pg';
import { parseBoolean } from '../media/media.module.js';
import { scrub } from '../system/scrub.js';

/**
 * Shared pieces of the backup tool (spec 9b.5, NFR-09): environment, child processes (pg_dump, pg_restore, age), the
 * encrypt-and-upload pipe, `backup_runs` rows and log lines. Rules: no secret on a command line (database passwords
 * reach pg_dump / pg_restore as PG* variables, age gets only the public recipient or an identity FILE path), children
 * get only PATH, a locale and their own variables, and nothing is printed or stored without `failureDetail` / `scrub`.
 */

export type Env = Record<string, string | undefined>;

export function need(env: Env, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

// ---------- spawn arguments (never a secret) ----------

const SNAPSHOT_ID = /^[0-9A-F]+-[0-9A-F]+(?:-[0-9]+)?$/i;
const DB_NAME = /^[a-z_][a-z0-9_]{0,62}$/;
/** pg_dump gives up instead of waiting forever for a table lock (a migration holding ACCESS EXCLUSIVE). */
export const LOCK_WAIT = '5min';

export function pgDumpArgs(snapshot: string): string[] {
  if (!SNAPSHOT_ID.test(snapshot)) throw new Error('unexpected snapshot id');
  return ['--format=custom', `--snapshot=${snapshot}`, '--no-owner', '--no-acl', `--lock-wait-timeout=${LOCK_WAIT}`];
}

/**
 * With `role`, pg_restore runs `SET ROLE <role>` after connecting, so every object it creates is created by, and
 * owned by, that role (the dump's own owners are ignored either way: `--no-owner`).
 */
export function pgRestoreArgs(database: string, dumpFile: string, role?: string | null): string[] {
  checkDbName(database);
  const roleArg = role == null ? [] : [`--role=${checkRoleName(role)}`];
  return ['--no-owner', '--no-acl', ...roleArg, '--exit-on-error', `--dbname=${database}`, dumpFile];
}

/** The recipient is a public key: fine on argv. */
export function ageEncryptArgs(recipient: string): string[] {
  return ['--encrypt', '--recipient', checkRecipient(recipient)];
}

/** Only the identity file's path is on argv, never the key. */
export function ageDecryptArgs(identityFile: string): string[] {
  return ['--decrypt', '--identity', identityFile];
}

export function checkRecipient(recipient: string): string {
  if (!/^age1[02-9ac-hj-np-z]{58}$/.test(recipient))
    throw new Error('BACKUP_AGE_RECIPIENT must be an age public key (age1...)');
  return recipient;
}

/** Lower-case names only: the restore target is created and dropped by name. */
export function checkDbName(name: string): string {
  if (!DB_NAME.test(name)) throw new Error('database name must match [a-z_][a-z0-9_]* (at most 63 characters)');
  return name;
}

/**
 * The same rule as `assertRoleName` in system/db-grants.ts (copied: the backup tool never loads the Prisma client).
 * The role is also quoted as an identifier wherever it goes into SQL.
 */
export function checkRoleName(name: string): string {
  if (!DB_NAME.test(name)) throw new Error('role name must match [a-z_][a-z0-9_]* (at most 63 characters)');
  return name;
}

// ---------- environment of a child process ----------

/** libpq variables from a postgresql:// URL, so the password never appears on a command line. */
export function pgEnv(url: string, database?: string): Record<string, string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('not a postgresql:// URL');
  }
  if (parsed.protocol !== 'postgresql:' && parsed.protocol !== 'postgres:') throw new Error('not a postgresql:// URL');
  const out: Record<string, string> = {
    PGHOST: decodeURIComponent(parsed.hostname).replace(/^\[(.*)\]$/, '$1') || 'localhost',
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: database ?? decodeURIComponent(parsed.pathname.slice(1)),
  };
  const sslmode = parsed.searchParams.get('sslmode');
  if (sslmode) out.PGSSLMODE = sslmode;
  for (const key of Object.keys(out)) if (out[key] === '') delete out[key];
  return out;
}

/** PATH, a locale and the given variables: no S3 key, no other secret of this process reaches a child. */
export function childEnv(extra: Record<string, string> = {}, base: Env = process.env): Record<string, string> {
  return { PATH: base.PATH ?? '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C.UTF-8', ...extra };
}

// ---------- child processes ----------

/** The first stderr line that mentions an error, else the first non-empty line. */
export function stderrDetail(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.find((l) => /error/i.test(l)) ?? lines[0] ?? 'no error output';
}

export interface Child {
  child: ChildProcess;
  /** Resolves on exit code 0; otherwise rejects with the command name and the first stderr line. */
  done: Promise<void>;
}

const STDERR_KEEP = 4096;

export function runChild(
  command: string,
  args: string[],
  env: Record<string, string>,
  signal: AbortSignal,
  stdin: 'pipe' | 'ignore' = 'pipe',
): Child {
  const child = spawn(command, args, { env, signal, stdio: [stdin, 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => {
    if (stderr.length < STDERR_KEEP) stderr += chunk.toString('utf8');
  });
  // A child that exits early closes its stdin: the writer gets EPIPE, the exit code tells the story.
  child.stdin?.on('error', () => undefined);
  const done = new Promise<void>((resolve, reject) => {
    child.once('error', (error) =>
      reject(
        new Error(error.name === 'AbortError' ? `${command} stopped` : `${command} could not run: ${error.message}`),
      ),
    );
    child.once('close', (code, sig) => {
      if (code === 0) resolve();
      else {
        reject(new Error(`${command} failed (${code ?? sig}): ${stderrDetail(stderr)}`));
      }
    });
  });
  done.catch(() => undefined);
  return { child, done };
}

// ---------- object store ----------

export interface S3Coordinates {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle: boolean;
}

/**
 * Socket timeouts only: a large dump upload or photo download may take minutes, but a stalled connection is cut off.
 */
export function s3Client(c: S3Coordinates): S3Client {
  return new S3Client({
    endpoint: c.endpoint,
    region: c.region,
    forcePathStyle: c.forcePathStyle,
    credentials: { accessKeyId: c.accessKeyId, secretAccessKey: c.secretAccessKey },
    maxAttempts: 3,
    requestHandler: { connectionTimeout: 10_000, requestTimeout: 60_000 },
  });
}

export function forcePathStyle(env: Env): boolean {
  return parseBoolean(env.S3_FORCE_PATH_STYLE, 'S3_FORCE_PATH_STYLE', true);
}

/** The backup bucket with the writer keys (PutObject + AbortMultipartUpload only: no GET, LIST or DELETE). */
export function backupWriter(env: Env): { client: S3Client; bucket: string } {
  return {
    client: s3Client({
      endpoint: need(env, 'BACKUP_S3_ENDPOINT'),
      region: need(env, 'BACKUP_S3_REGION'),
      accessKeyId: need(env, 'BACKUP_S3_ACCESS_KEY_ID'),
      secretAccessKey: need(env, 'BACKUP_S3_SECRET_ACCESS_KEY'),
      forcePathStyle: forcePathStyle(env),
    }),
    bucket: need(env, 'BACKUP_S3_BUCKET'),
  };
}

/** The backup bucket with the reader keys (restore only, one-off environment). */
export function backupReader(env: Env): { client: S3Client; bucket: string } {
  return {
    client: s3Client({
      endpoint: need(env, 'BACKUP_S3_ENDPOINT'),
      region: need(env, 'BACKUP_S3_REGION'),
      accessKeyId: need(env, 'BACKUP_READ_ACCESS_KEY_ID'),
      secretAccessKey: need(env, 'BACKUP_READ_SECRET_ACCESS_KEY'),
      forcePathStyle: forcePathStyle(env),
    }),
    bucket: need(env, 'BACKUP_S3_BUCKET'),
  };
}

const PART_SIZE = 16 * 1024 * 1024;

/**
 * `source` → `age --encrypt` → the backup bucket (lib-storage: one PutObject, or a multipart upload for a large body).
 * The upload body is ended only after the source and age both finished cleanly, so a failed dump never completes an
 * object: the upload is aborted instead. A failed upload stops the children. Returns the encrypted size.
 */
export async function encryptToBucket(opts: {
  source: Readable;
  /** Resolves when the producer of `source` succeeded (pg_dump's exit, the end of a download). */
  sourceDone: Promise<void>;
  recipient: string;
  client: S3Client;
  bucket: string;
  key: string;
  signal?: AbortSignal;
  /** Test seam: the encrypting command (default `age --encrypt --recipient <recipient>`). */
  encryptor?: { command: string; args: string[] };
}): Promise<number> {
  const controller = new AbortController();
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener('abort', onOuterAbort, { once: true });
  let first: unknown;
  const fail = (error: unknown) => {
    first ??= error;
    controller.abort();
  };

  const encryptor = opts.encryptor ?? { command: 'age', args: ageEncryptArgs(opts.recipient) };
  const age = runChild(encryptor.command, encryptor.args, childEnv(), controller.signal);
  opts.source.once('error', fail);
  opts.source.pipe(age.child.stdin!);

  let bytes = 0;
  const body = new PassThrough();
  age.child.stdout!.on('data', (chunk: Buffer) => (bytes += chunk.length));
  age.child.stdout!.pipe(body, { end: false });

  const upload = new Upload({
    client: opts.client,
    params: { Bucket: opts.bucket, Key: opts.key, Body: body, ContentType: 'application/octet-stream' },
    partSize: PART_SIZE,
    queueSize: 2,
    leavePartsOnError: false,
  });
  const uploaded = upload.done().catch((error: unknown) => {
    fail(error);
    throw error;
  });
  uploaded.catch(() => undefined);

  try {
    await Promise.all([opts.sourceDone, age.done]);
    if (opts.signal?.aborted) throw new Error('stopped');
    body.end();
    await uploaded;
    return bytes;
  } catch (error) {
    fail(error);
    await upload.abort().catch(() => undefined);
    body.destroy();
    opts.source.destroy();
    await uploaded.catch(() => undefined);
    throw first;
  } finally {
    opts.signal?.removeEventListener('abort', onOuterAbort);
  }
}

/** `age --decrypt` of a stream; the caller consumes `stdout` and awaits `done` and `sourceDone`. */
export function decrypt(source: Readable, identityFile: string, signal: AbortSignal): Child {
  const age = runChild('age', ageDecryptArgs(identityFile), childEnv(), signal);
  source.pipe(age.child.stdin!);
  return age;
}

// ---------- backup_runs ----------

export type BackupKind = 'db' | 'media' | 'restore_test';

export interface RunOutcome {
  ok: boolean;
  bytes?: number | null;
  objects?: number | null;
  detail?: string | null;
}

/**
 * `backup_runs` rows through a plain connection as the backup role (INSERT + UPDATE only on this table). Times are
 * UTC wall-clock values in `timestamp(3)` columns, the way Prisma writes them, whatever the process time zone is.
 */
export class BackupRuns {
  private constructor(private readonly client: pg.Client) {}

  static async connect(url: string): Promise<BackupRuns> {
    const client = new pg.Client({ connectionString: url, application_name: 'nesto-backup' });
    await client.connect();
    return new BackupRuns(client);
  }

  async start(kind: BackupKind, startedAt: Date): Promise<number> {
    const { rows } = await this.client.query<{ id: number }>(
      `INSERT INTO backup_runs (kind, started_at) VALUES ($1::backup_kind, ($2::timestamptz AT TIME ZONE 'UTC')) RETURNING id`,
      [kind, startedAt.toISOString()],
    );
    return rows[0].id;
  }

  async finish(id: number, outcome: RunOutcome): Promise<void> {
    await this.client.query(
      `UPDATE backup_runs SET finished_at = ($2::timestamptz AT TIME ZONE 'UTC'), ok = $3, bytes = $4, objects = $5, detail = $6 WHERE id = $1`,
      [
        id,
        new Date().toISOString(),
        outcome.ok,
        outcome.bytes ?? null,
        outcome.objects ?? null,
        outcome.detail ? outcome.detail.slice(0, 500) : null,
      ],
    );
  }

  /** `startedAt` of the newest successful run of a kind, or null. */
  async lastOkStart(kind: BackupKind): Promise<Date | null> {
    const { rows } = await this.client.query<{ started: Date }>(
      `SELECT started_at AT TIME ZONE 'UTC' AS started FROM backup_runs WHERE kind = $1::backup_kind AND ok ORDER BY started_at DESC LIMIT 1`,
      [kind],
    );
    return rows[0]?.started ?? null;
  }

  async close(): Promise<void> {
    await this.client.end().catch(() => undefined);
  }
}

// ---------- keys, details, logs ----------

/** `db/<UTC date>/nesto-<ISO>.dump.age` and its counts file. */
export function dumpKeys(startedAt: Date): { dump: string; counts: string } {
  const iso = startedAt.toISOString();
  const base = `db/${iso.slice(0, 10)}/nesto-${iso}`;
  return { dump: `${base}.dump.age`, counts: `${base}.counts.json.age` };
}

const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]*@/gi;
export const DETAIL_MAX = 500;

/** What may be stored in `backup_runs.detail` or printed: the first line, no URL credentials, scrubbed, ≤ 500 chars. */
export function failureDetail(error: unknown): string {
  let text: string;
  if (error instanceof Error) {
    const message = error.message.split(/\r?\n/).find((l) => l.trim()) ?? '';
    text = error.name && error.name !== 'Error' ? `${error.name}: ${message}` : message || error.name || 'Error';
  } else text = String(error).split(/\r?\n/)[0];
  return scrub(text.replace(URL_CREDENTIALS, '$1[redacted]@').trim()).slice(0, DETAIL_MAX);
}

export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** One JSON line in the API's log shape (`level`, `pid`, `timestamp`, `context`, `message`), every string scrubbed. */
export function logLine(level: 'log' | 'warn' | 'error', message: string, fields: LogFields = {}): void {
  const entry: Record<string, unknown> = {
    level,
    pid: process.pid,
    timestamp: new Date().toISOString(),
    context: 'Backup',
    message: scrub(message),
  };
  for (const [key, value] of Object.entries(fields))
    if (value !== undefined) entry[key] = typeof value === 'string' ? scrub(value) : value;
  (level === 'log' ? process.stdout : process.stderr).write(`${JSON.stringify(entry)}\n`);
}
