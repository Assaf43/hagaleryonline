import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import { runDbBackup } from '../src/backup/backup-db.js';
import { runMediaBackup } from '../src/backup/backup-media.js';
import { restoreDb, restoreMedia } from '../src/backup/restore.js';

/**
 * The backup tool against the test database and MinIO (spec 9b.5). Needs S3_TEST_ENDPOINT plus `age`, `age-keygen`,
 * `pg_dump` and `pg_restore` (18) on PATH: run it in a container with postgresql-client-18 and age (see the Task 18
 * report); skipped otherwise. A throwaway age key is made in a temp dir; buckets and restore targets get random names
 * and are always removed. It never touches the dev database.
 */
const endpoint = process.env.S3_TEST_ENDPOINT;
const has = (cmd: string) => spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
const tools = ['age', 'age-keygen', 'pg_dump', 'pg_restore'].filter((cmd) => !has(cmd));
const skipReason = !endpoint
  ? 'S3_TEST_ENDPOINT is not set (start MinIO, see ci.yml)'
  : tools.length
    ? `not on PATH: ${tools.join(', ')} (run inside an image with postgresql-client-18 and age)`
    : null;
if (skipReason) console.warn(`backup e2e SKIPPED: ${skipReason}`);

describe.skipIf(!!skipReason)('backup tool (e2e, MinIO + test DB)', () => {
  const accessKeyId = process.env.S3_TEST_ACCESS_KEY_ID || 'minioadmin';
  const secretAccessKey = process.env.S3_TEST_SECRET_ACCESS_KEY || 'minioadmin';
  const suffix = randomBytes(4).toString('hex');
  const publicBucket = `nesto-bk-pub-${suffix}`;
  const privateBucket = `nesto-bk-priv-${suffix}`;
  const backupBucket = `nesto-bk-backup-${suffix}`;
  const targets = [1, 2, 3, 4].map((n) => `nesto_restore_e2e_${suffix}_${n}`);
  const testUrl = process.env.DATABASE_URL!;
  const adminUrl = (() => {
    const u = new URL(testUrl);
    u.pathname = '/postgres';
    return u.toString();
  })();
  const s3 = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
  const admin = new pg.Client({ connectionString: adminUrl });
  const db = new pg.Client({ connectionString: testUrl });
  const runIds: number[] = [];
  let dir: string;
  let identity: string;
  let recipient: string;
  let env: Record<string, string>;
  let dumpKey: string;

  const keysOf = async (Bucket: string, Prefix?: string) =>
    ((await s3.send(new ListObjectsV2Command({ Bucket, Prefix }))).Contents ?? []).map((o) => o.Key!).sort();
  const getBytes = async (Bucket: string, Key: string) =>
    Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body!.transformToByteArray());
  const emptyAndDelete = async (Bucket: string) => {
    const keys = await keysOf(Bucket);
    if (keys.length)
      await s3.send(new DeleteObjectsCommand({ Bucket, Delete: { Objects: keys.map((Key) => ({ Key })) } }));
    await s3.send(new DeleteBucketCommand({ Bucket }));
  };
  const databaseExists = async (name: string) =>
    !!(await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [name])).rowCount;
  const run = async (id: number) =>
    (
      await db.query<{
        kind: string;
        ok: boolean | null;
        bytes: string | null;
        objects: number | null;
        detail: string | null;
      }>('SELECT kind, ok, bytes, objects, detail FROM backup_runs WHERE id = $1', [id])
    ).rows[0];
  const lastRestoreRow = async () => {
    const { rows } = await db.query<{ id: number; ok: boolean | null; detail: string | null }>(
      `SELECT id, ok, detail FROM backup_runs WHERE kind = 'restore_test' ORDER BY id DESC LIMIT 1`,
    );
    runIds.push(rows[0].id);
    return rows[0];
  };
  const ageRun = (args: string[], input: Buffer) => {
    const out = spawnSync('age', args, { input });
    if (out.status !== 0) throw new Error(`age failed: ${out.stderr.toString()}`);
    return out.stdout;
  };

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'nesto-backup-e2e-'));
    await chmod(dir, 0o700);
    identity = join(dir, 'identity.txt');
    const keygen = spawnSync('age-keygen', ['-o', identity], { stdio: 'pipe' });
    if (keygen.status !== 0) throw new Error('age-keygen failed');
    recipient = /public key: (age1[0-9a-z]+)/.exec(await readFile(identity, 'utf8'))![1];

    for (const Bucket of [publicBucket, privateBucket, backupBucket])
      await s3.send(new CreateBucketCommand({ Bucket }));
    await admin.connect();
    await db.connect();
    // The media run decides "new" from the last successful media row: start from none.
    await db.query(`DELETE FROM backup_runs WHERE kind = 'media'`);

    env = {
      BACKUP_DATABASE_URL: testUrl,
      BACKUP_AGE_RECIPIENT: recipient,
      BACKUP_S3_ENDPOINT: endpoint!,
      BACKUP_S3_REGION: 'us-east-1',
      BACKUP_S3_BUCKET: backupBucket,
      BACKUP_S3_ACCESS_KEY_ID: accessKeyId,
      BACKUP_S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_ENDPOINT: endpoint!,
      S3_REGION: 'us-east-1',
      S3_PUBLIC_BUCKET: publicBucket,
      S3_PRIVATE_BUCKET: privateBucket,
      S3_FORCE_PATH_STYLE: 'true',
      RESTORE_ADMIN_DATABASE_URL: adminUrl,
      RESTORE_RECORD_DATABASE_URL: testUrl,
      BACKUP_READ_ACCESS_KEY_ID: accessKeyId,
      BACKUP_READ_SECRET_ACCESS_KEY: secretAccessKey,
      RESTORE_S3_ACCESS_KEY_ID: accessKeyId,
      RESTORE_S3_SECRET_ACCESS_KEY: secretAccessKey,
    };
  });

  afterAll(async () => {
    for (const name of targets)
      await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => undefined);
    if (runIds.length)
      await db.query('DELETE FROM backup_runs WHERE id = ANY($1::int[])', [runIds]).catch(() => undefined);
    await admin.end().catch(() => undefined);
    await db.end().catch(() => undefined);
    for (const Bucket of [publicBucket, privateBucket, backupBucket])
      await emptyAndDelete(Bucket).catch(() => undefined);
    s3.destroy();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('db backup then restore gives the same counts', { timeout: 120_000 }, async () => {
    const result = await runDbBackup(env);
    runIds.push(result.runId);
    expect(result).toMatchObject({ ok: true, detail: null, objects: 2 });
    dumpKey = result.key!;
    expect(dumpKey).toMatch(/^db\/\d{4}-\d{2}-\d{2}\/nesto-.+\.dump\.age$/);
    const countsKey = dumpKey.replace(/\.dump\.age$/, '.counts.json.age');
    expect(await keysOf(backupBucket, 'db/')).toEqual([countsKey, dumpKey].sort());
    const row = await run(result.runId);
    expect(row).toMatchObject({ kind: 'db', ok: true, detail: null });
    expect(Number(row.bytes)).toBe(result.bytes);
    expect(result.bytes).toBeGreaterThan(1000);

    // Encrypted: an age file, no pg_dump header, no table name in the clear.
    const stored = await getBytes(backupBucket, dumpKey);
    expect(stored.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(stored.includes(Buffer.from('PGDMP'))).toBe(false);
    expect(stored.includes(Buffer.from('backup_runs'))).toBe(false);

    const restored = await restoreDb(env, { object: dumpKey, identity, targetDb: targets[0] });
    expect(restored).toMatchObject({ ok: true, mismatches: [], detail: null });
    expect(restored.tables).toBeGreaterThan(30);
    expect(await databaseExists(targets[0])).toBe(false);
    expect(await lastRestoreRow()).toMatchObject({ ok: true, detail: null });
  });

  it('counts mismatch fails the restore', { timeout: 120_000 }, async () => {
    const countsKey = dumpKey.replace(/\.dump\.age$/, '.counts.json.age');
    const counts = JSON.parse(
      ageRun(['--decrypt', '--identity', identity], await getBytes(backupBucket, countsKey)).toString(),
    ) as { tables: Record<string, number> };
    const real = counts.tables.products;
    expect(real).toBeGreaterThan(0);
    counts.tables.products = real + 1;
    await s3.send(
      new PutObjectCommand({
        Bucket: backupBucket,
        Key: countsKey,
        Body: ageRun(['--encrypt', '--recipient', recipient], Buffer.from(JSON.stringify(counts))),
      }),
    );

    const restored = await restoreDb(env, { object: dumpKey, identity, targetDb: targets[1] });
    expect(restored.ok).toBe(false);
    expect(restored.mismatches).toEqual([`products: expected ${real + 1}, got ${real}`]);
    expect(restored.detail).toBe(`row counts differ in 1 tables: products: expected ${real + 1}, got ${real}`);
    expect(await databaseExists(targets[1])).toBe(false);
    expect(await lastRestoreRow()).toMatchObject({ ok: false, detail: restored.detail });
  });

  it('existing target refused, empty or not', { timeout: 60_000 }, async () => {
    const restoreTestRows = async () =>
      (await db.query(`SELECT count(*)::int AS n FROM backup_runs WHERE kind = 'restore_test'`)).rows[0].n as number;
    const before = await restoreTestRows();

    // Non-empty: a table the restore must never touch.
    await admin.query(`CREATE DATABASE "${targets[2]}"`);
    const other = new pg.Client({ connectionString: adminUrl.replace(/\/postgres$/, `/${targets[2]}`) });
    await other.connect();
    await other.query('CREATE TABLE keep_me (id int)');
    await other.end();
    await expect(restoreDb(env, { object: dumpKey, identity, targetDb: targets[2] })).rejects.toThrow(
      `target database ${targets[2]} already exists`,
    );
    expect(await databaseExists(targets[2])).toBe(true);

    // Empty: refused the same way, and not dropped.
    await admin.query(`CREATE DATABASE "${targets[3]}"`);
    await expect(restoreDb(env, { object: dumpKey, identity, targetDb: targets[3] })).rejects.toThrow(
      `target database ${targets[3]} already exists: choose a new name`,
    );
    expect(await databaseExists(targets[3])).toBe(true);

    expect(await restoreTestRows()).toBe(before);
    // Neither the dev nor the record database is ever a target.
    await expect(
      restoreDb(env, { object: dumpKey, identity, targetDb: new URL(testUrl).pathname.slice(1) }),
    ).rejects.toThrow('refusing to restore into');
  });

  it('failed upload writes ok=false with a scrubbed detail', { timeout: 60_000 }, async () => {
    const result = await runDbBackup({ ...env, BACKUP_S3_BUCKET: `nesto-bk-missing-${suffix}` });
    runIds.push(result.runId);
    expect(result.ok).toBe(false);
    const row = await run(result.runId);
    expect(row).toMatchObject({ kind: 'db', ok: false });
    expect(row.detail).toBe(result.detail);
    expect(row.detail).toMatch(/NoSuchBucket|bucket does not exist/i);
    expect(row.detail!.length).toBeLessThanOrEqual(500);
    expect(row.detail).not.toContain('\n');
    const dbPassword = decodeURIComponent(new URL(testUrl).password);
    for (const secret of [secretAccessKey, dbPassword, recipient]) expect(row.detail).not.toContain(secret);
    expect(row.detail).not.toMatch(/:\/\/[^/\s]*@/);
  });

  it('media backs up only new objects', { timeout: 60_000 }, async () => {
    const photo = randomBytes(2048);
    await s3.send(new PutObjectCommand({ Bucket: publicBucket, Key: 'products/1/a-480.webp', Body: photo }));
    await s3.send(
      new PutObjectCommand({ Bucket: privateBucket, Key: 'support/7/x.webp', Body: Buffer.from('private') }),
    );

    const first = await runMediaBackup(env);
    runIds.push(first.runId);
    expect(first).toMatchObject({ ok: true, objects: 2, detail: null });
    expect(await run(first.runId)).toMatchObject({ kind: 'media', ok: true, objects: 2 });

    // LastModified has (at best) second precision: put the next photo clearly after the first run started.
    await new Promise((resolve) => setTimeout(resolve, 2100));
    await s3.send(new PutObjectCommand({ Bucket: publicBucket, Key: 'products/1/b-480.webp', Body: photo }));
    // No overlap here (the real one is an hour): only b is newer than the first run's start.
    const second = await runMediaBackup(env, { overlapMs: 0 });
    runIds.push(second.runId);
    expect(second).toMatchObject({ ok: true, objects: 1 });

    expect(await keysOf(backupBucket, 'media/')).toEqual([
      'media/private/support/7/x.webp.age',
      'media/public/products/1/a-480.webp.age',
      'media/public/products/1/b-480.webp.age',
    ]);
    const stored = await getBytes(backupBucket, 'media/private/support/7/x.webp.age');
    expect(stored.subarray(0, 21).toString()).toBe('age-encryption.org/v1');
    expect(stored.includes(Buffer.from('private'))).toBe(false);
    expect(ageRun(['--decrypt', '--identity', identity], stored).toString()).toBe('private');
  });

  it('restore-media puts objects back', { timeout: 60_000 }, async () => {
    const original = await getBytes(publicBucket, 'products/1/a-480.webp');
    await s3.send(
      new DeleteObjectsCommand({ Bucket: publicBucket, Delete: { Objects: [{ Key: 'products/1/a-480.webp' }] } }),
    );
    await s3.send(
      new DeleteObjectsCommand({ Bucket: privateBucket, Delete: { Objects: [{ Key: 'support/7/x.webp' }] } }),
    );

    const result = await restoreMedia(env, { identity });
    expect(result).toEqual({ ok: true, restored: 2, skipped: 1, failed: 0, detail: null });
    expect((await getBytes(publicBucket, 'products/1/a-480.webp')).equals(original)).toBe(true);
    expect((await getBytes(privateBucket, 'support/7/x.webp')).toString()).toBe('private');
    const head = await s3.send(new HeadObjectCommand({ Bucket: publicBucket, Key: 'products/1/a-480.webp' }));
    expect(head.ContentType).toBe('image/webp');

    // Again: everything exists now.
    expect(await restoreMedia(env, { identity, prefix: 'media/public/' })).toMatchObject({ restored: 0, skipped: 2 });
  });
});
