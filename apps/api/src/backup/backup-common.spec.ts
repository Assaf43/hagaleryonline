import {
  ageDecryptArgs,
  assertBackupProductionEnv,
  ageEncryptArgs,
  checkRecipient,
  checkRoleName,
  childEnv,
  dumpKeys,
  failureDetail,
  pgDumpArgs,
  pgEnv,
  pgRestoreArgs,
  runChild,
  stderrDetail,
  encryptToBucket,
} from './backup-common.js';
import { S3Client } from '@aws-sdk/client-s3';
import { Readable } from 'node:stream';

const PASSWORD = 'S3cr3t-Pa55word-not-for-anything';
const URL_WITH_SECRET = `postgresql://nesto_backup:${encodeURIComponent(PASSWORD)}@postgres:5432/nesto?sslmode=require`;
const RECIPIENT = 'age1ql3z7hjy54pw3hyww5ayyfg7zqgvc7w3j2elw8zmrj2kg5sfn9aqmcac8p';

describe('spawn arguments never hold a secret (they come from the environment)', () => {
  const all = [
    ...pgDumpArgs('00000003-0000001B-1'),
    ...ageEncryptArgs(RECIPIENT),
    ...ageDecryptArgs('/run/identity.txt'),
    ...pgRestoreArgs('nesto_restore_check', '/tmp/x/dump'),
    ...pgRestoreArgs('nesto_restore_check', '/tmp/x/dump', 'nesto_owner'),
  ];

  it('no password, user or URL in any argument', () => {
    for (const arg of all) {
      expect(arg).not.toContain(PASSWORD);
      expect(arg).not.toContain('nesto_backup');
      expect(arg).not.toMatch(/:\/\//);
    }
  });

  it('pg_dump: custom format, the exported snapshot, no owner, no ACL, a lock wait limit; the database comes from PGDATABASE', () => {
    expect(pgDumpArgs('00000003-0000001B-1')).toEqual([
      '--format=custom',
      '--snapshot=00000003-0000001B-1',
      '--no-owner',
      '--no-acl',
      '--lock-wait-timeout=5min',
    ]);
  });

  it('refuses a snapshot id that is not one', () => {
    expect(() => pgDumpArgs('--file=/etc/passwd')).toThrow('unexpected snapshot id');
  });

  it('age: the public recipient on argv, decrypt with an identity file path', () => {
    expect(ageEncryptArgs(RECIPIENT)).toEqual(['--encrypt', '--recipient', RECIPIENT]);
    expect(ageDecryptArgs('/run/identity.txt')).toEqual(['--decrypt', '--identity', '/run/identity.txt']);
  });

  it('pg_restore: no owner, no ACL, stops at the first error, a plain database name', () => {
    expect(pgRestoreArgs('nesto_restore_check', '/tmp/x/dump')).toEqual([
      '--no-owner',
      '--no-acl',
      '--exit-on-error',
      '--dbname=nesto_restore_check',
      '/tmp/x/dump',
    ]);
    expect(() => pgRestoreArgs('host=evil dbname=x', '/tmp/x/dump')).toThrow();
  });

  it('pg_restore with an owner: --role=<owner>, still no owner and no ACL from the dump', () => {
    expect(pgRestoreArgs('nesto_restored', '/tmp/x/dump', 'nesto_owner')).toEqual([
      '--no-owner',
      '--no-acl',
      '--role=nesto_owner',
      '--exit-on-error',
      '--dbname=nesto_restored',
      '/tmp/x/dump',
    ]);
    expect(pgRestoreArgs('nesto_restored', '/tmp/x/dump', null)).not.toContainEqual(expect.stringMatching(/^--role/));
    for (const bad of ['Nesto', 'x y', 'a;DROP', '--superuser', '"q"', '', 'a'.repeat(64)])
      expect(() => pgRestoreArgs('nesto_restored', '/tmp/x/dump', bad), bad).toThrow('role name must match');
  });
});

describe('checkRoleName', () => {
  it('accepts lower-case identifiers up to 63 characters, the rule of db-grants.ts', () => {
    expect(checkRoleName('nesto_owner')).toBe('nesto_owner');
    expect(checkRoleName('_r2')).toBe('_r2');
    expect(checkRoleName('a'.repeat(63))).toBe('a'.repeat(63));
    for (const bad of ['1abc', 'Owner', 'own-er', 'a'.repeat(64), 'x"y'])
      expect(() => checkRoleName(bad), bad).toThrow('role name must match');
  });
});

describe('assertBackupProductionEnv', () => {
  const SENTINEL = 'SENTINEL-backup-value-never-printed';
  const prodEnv = (extra: Record<string, string | undefined> = {}) => ({
    NODE_ENV: 'production',
    BACKUP_DATABASE_URL: URL_WITH_SECRET,
    BACKUP_AGE_RECIPIENT: RECIPIENT,
    BACKUP_S3_ENDPOINT: 'https://backups.example.test',
    S3_ENDPOINT: 'https://s3.example.test',
    ...extra,
  });
  const problemOf = (env: Record<string, string | undefined>): string => {
    try {
      assertBackupProductionEnv(env);
    } catch (error) {
      return (error as Error).message;
    }
    return '';
  };

  it('accepts a production environment, and does nothing outside production', () => {
    expect(problemOf(prodEnv())).toBe('');
    expect(problemOf(prodEnv({ BACKUP_DATABASE_URL: 'postgresql://u:p@postgres:5432/nesto' }))).toBe('');
    expect(problemOf({})).toBe('');
    expect(problemOf({ NODE_ENV: 'development', S3_ENDPOINT: 'http://s3.example.test' })).toBe('');
  });

  it('backup refuses http endpoint in production', () => {
    const message = problemOf(
      prodEnv({ BACKUP_S3_ENDPOINT: 'http://minio:9000', S3_ENDPOINT: `http://${SENTINEL}.example.test` }),
    );
    expect(message).toContain('BACKUP_S3_ENDPOINT: must be an https URL');
    expect(message).toContain('S3_ENDPOINT: must be an https URL');
    expect(message).not.toContain(SENTINEL);
    expect(message).not.toContain('minio');
    expect(message).not.toContain('\n');
  });

  it('backup allows http minio host on staging', () => {
    const staging = { APP_ENV: 'staging', BACKUP_S3_ENDPOINT: 'http://minio:9000', S3_ENDPOINT: 'http://minio:9000' };
    expect(problemOf(prodEnv(staging))).toBe('');
    expect(problemOf(prodEnv({ ...staging, S3_ENDPOINT: 'http://minio.localhost:9000' }))).toBe('');
    expect(problemOf(prodEnv({ ...staging, BACKUP_S3_ENDPOINT: 'http://s3.example.test' }))).toContain(
      'BACKUP_S3_ENDPOINT: must be an https URL',
    );
  });

  it('backup refuses remote db without sslmode', () => {
    const remote = `postgresql://nesto_backup:${SENTINEL}@db.example.test:5432/nesto`;
    for (const url of [
      remote,
      `${remote}?sslmode=prefer`,
      `${remote}?sslmode=disable`,
      remote.replace('db.example.test', '10.0.0.5'),
    ]) {
      const message = problemOf(prodEnv({ BACKUP_DATABASE_URL: url }));
      expect(message, url).toContain(
        'BACKUP_DATABASE_URL: a remote database needs sslmode=require, verify-ca or verify-full',
      );
      expect(message).not.toContain(SENTINEL);
    }
    for (const mode of ['require', 'verify-ca', 'verify-full'])
      expect(problemOf(prodEnv({ BACKUP_DATABASE_URL: `${remote}?sslmode=${mode}` })), mode).toBe('');
    expect(problemOf(prodEnv({ BACKUP_DATABASE_URL: SENTINEL }))).toBe(
      'Refusing to run in production: BACKUP_DATABASE_URL: not a postgresql:// URL',
    );
  });

  it('backup refuses non-age recipient', () => {
    const message = problemOf(prodEnv({ BACKUP_AGE_RECIPIENT: `AGE-SECRET-KEY-1${SENTINEL}` }));
    expect(message).toBe('Refusing to run in production: BACKUP_AGE_RECIPIENT: must be an age public key (age1...)');
  });

  it('names every missing variable in one line', () => {
    expect(problemOf({ NODE_ENV: 'production' })).toBe(
      'Refusing to run in production: BACKUP_DATABASE_URL: missing; BACKUP_AGE_RECIPIENT: missing; ' +
        'BACKUP_S3_ENDPOINT: missing; S3_ENDPOINT: missing',
    );
  });
});

describe('checkRecipient', () => {
  it('accepts an age public key and refuses anything else (a secret key above all)', () => {
    expect(checkRecipient(RECIPIENT)).toBe(RECIPIENT);
    expect(() => checkRecipient('AGE-SECRET-KEY-1QQQ')).toThrow('BACKUP_AGE_RECIPIENT');
    expect(() => checkRecipient('')).toThrow('BACKUP_AGE_RECIPIENT');
  });
});

describe('pgEnv', () => {
  it('splits the URL into PG* variables (the password only in PGPASSWORD)', () => {
    expect(pgEnv(URL_WITH_SECRET)).toEqual({
      PGHOST: 'postgres',
      PGPORT: '5432',
      PGUSER: 'nesto_backup',
      PGPASSWORD: PASSWORD,
      PGDATABASE: 'nesto',
      PGSSLMODE: 'require',
    });
  });

  it('can point at another database; defaults the port; IPv6 hosts lose their brackets', () => {
    expect(pgEnv('postgresql://u:p@[::1]/x', 'other')).toEqual({
      PGHOST: '::1',
      PGPORT: '5432',
      PGUSER: 'u',
      PGPASSWORD: 'p',
      PGDATABASE: 'other',
    });
  });

  it('refuses another scheme without printing the URL', () => {
    expect(() => pgEnv(`mysql://u:${PASSWORD}@h/x`)).toThrow(/^not a postgresql:\/\/ URL$/);
  });
});

describe('childEnv', () => {
  it('passes only PATH, a locale and the given variables (no S3 key reaches pg_dump or age)', () => {
    const env = childEnv(
      { PGPASSWORD: 'x' },
      { PATH: '/usr/bin', BACKUP_S3_SECRET_ACCESS_KEY: 'k', HOME: '/home/node' },
    );
    expect(env).toEqual({ PATH: '/usr/bin', LC_ALL: 'C.UTF-8', PGPASSWORD: 'x' });
  });
});

describe('failureDetail', () => {
  it('one scrubbed line, credentials removed from URLs, at most 500 characters', () => {
    const error = new Error(`connect to ${URL_WITH_SECRET} failed\nsecond line ${PASSWORD}`);
    const detail = failureDetail(error);
    expect(detail).toBe('connect to postgresql://[redacted]@postgres:5432/nesto?sslmode=require failed');
    expect(failureDetail(new Error('x'.repeat(2000))).length).toBeLessThanOrEqual(500);
  });

  it('keeps an S3 error name and scrubs tokens and e-mails', () => {
    const error = Object.assign(new Error('The specified bucket does not exist'), { name: 'NoSuchBucket' });
    expect(failureDetail(error)).toBe('NoSuchBucket: The specified bucket does not exist');
    expect(failureDetail(new Error('owner a@b.example key=abcdef0123456789abcdef0123456789'))).toBe(
      'owner [email] key=[secret]',
    );
    expect(failureDetail('plain')).toBe('plain');
    expect(failureDetail(new Error(''))).toBe('Error');
  });
});

describe('dumpKeys', () => {
  it('db/<UTC date>/nesto-<ISO>.dump.age and the counts file next to it', () => {
    expect(dumpKeys(new Date('2026-11-26T00:30:00.123Z'))).toEqual({
      dump: 'db/2026-11-26/nesto-2026-11-26T00:30:00.123Z.dump.age',
      counts: 'db/2026-11-26/nesto-2026-11-26T00:30:00.123Z.counts.json.age',
    });
  });
});

describe('stderrDetail', () => {
  it('prefers the first line mentioning an error, else the first non-empty line', () => {
    expect(stderrDetail('\npg_dump: warning: x\npg_dump: error: query failed\nmore error')).toBe(
      'pg_dump: error: query failed',
    );
    expect(stderrDetail('  \nsomething went wrong\nnext')).toBe('something went wrong');
    expect(stderrDetail('')).toBe('no error output');
  });
});

describe('encryptToBucket', () => {
  /** A real S3Client whose requests never leave the process: every command name is recorded and answered. */
  function stubClient() {
    const calls: string[] = [];
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'http://127.0.0.1:9',
      credentials: { accessKeyId: 'a', secretAccessKey: 'b' },
    });
    client.middlewareStack.add(
      (_next, context) => async () => {
        calls.push(context.commandName ?? '?');
        const outputs: Record<string, unknown> = {
          PutObjectCommand: { ETag: '"e"' },
          CreateMultipartUploadCommand: { UploadId: 'u' },
          UploadPartCommand: { ETag: '"p"' },
          CompleteMultipartUploadCommand: {},
          AbortMultipartUploadCommand: {},
        };
        return { output: { $metadata: {}, ...(outputs[context.commandName ?? ''] as object) }, response: {} };
      },
      { step: 'initialize', name: 'recordAndAnswer' },
    );
    return { client, calls };
  }
  // A pass-through "encryptor" so the test needs no age binary.
  const cat = { command: process.execPath, args: ['-e', 'process.stdin.pipe(process.stdout)'] };
  const abort = new AbortController();

  it('a source that exits non-zero: the call rejects and no object is completed', async () => {
    const { client, calls } = stubClient();
    // Like pg_dump failing late: its whole output is written and ended, and the process exits non-zero a moment later.
    const producer = runChild(
      process.execPath,
      ['-e', "setTimeout(() => { process.stderr.write('pg_dump: error: boom\\n'); process.exit(3); }, 400)"],
      { PATH: process.env.PATH ?? '' },
      abort.signal,
      'ignore',
    );
    await expect(
      encryptToBucket({
        source: Readable.from([Buffer.from('x'.repeat(5000))]),
        sourceDone: producer.done,
        recipient: 'unused',
        client,
        bucket: 'b',
        key: 'k',
        encryptor: cat,
      }),
    ).rejects.toThrow(`${process.execPath} failed (3): pg_dump: error: boom`);
    expect(calls).not.toContain('PutObjectCommand');
    expect(calls).not.toContain('CompleteMultipartUploadCommand');
    client.destroy();
  });

  it('a clean source is uploaded (the stub answers PutObject)', async () => {
    const { client, calls } = stubClient();
    const bytes = await encryptToBucket({
      source: Readable.from([Buffer.from('hello')]),
      sourceDone: Promise.resolve(),
      recipient: 'unused',
      client,
      bucket: 'b',
      key: 'k',
      encryptor: cat,
    });
    expect(bytes).toBe(5);
    expect(calls).toEqual(['PutObjectCommand']);
    client.destroy();
  });
});
