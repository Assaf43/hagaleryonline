import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { checkProductionEnv, PRODUCTION_ENV_RULES } from '../apps/api/src/config/production-env.ts';
import { buildRehearsalEnv, formatEnv, SECRET_NAMES, writeRehearsalEnv } from '../deploy/rehearsal/make-env.mjs';

// Spec 9b.7: the generated rehearsal env passes the API's production check (APP_ENV=staging) and holds fresh,
// distinct secrets. Only a test recipient is used here (64 characters, the shape of an age public key).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const RECIPIENT = `age1${'q'.repeat(58)}`;
const envOf = (pairs) => Object.fromEntries(pairs);

/** Every `${NAME…}` the compose files interpolate. */
function composeNames(file) {
  const text = readFileSync(join(root, file), 'utf8')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  return [...new Set([...text.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]))];
}

let dirs = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'make-env-'));
  dirs.push(dir);
  return dir;
};

describe('buildRehearsalEnv', () => {
  it('sets every variable the production check needs, and each is documented in .env.example', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    const example = readFileSync(join(root, '.env.example'), 'utf8');
    for (const { name } of PRODUCTION_ENV_RULES) {
      expect(env[name], name).toBeTruthy();
      expect(example, name).toMatch(new RegExp(`^#? ?${name}=`, 'm'));
    }
  });

  it('passes checkProductionEnv as staging', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    expect(env.APP_ENV).toBe('staging');
    expect(env.NODE_ENV).toBe('production');
    expect(checkProductionEnv(env)).toEqual([]);
  });

  it('uses the rehearsal hosts, s3 storage, the mocks and the sandbox', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    expect(env).toMatchObject({
      SITE_URL: 'https://nesto.localhost',
      STOREFRONT_URL: 'https://nesto.localhost',
      ADMIN_URL: 'https://admin.nesto.localhost',
      NG_ALLOWED_HOSTS: 'nesto.localhost',
      SEO_INDEXING: 'false',
      STOREFRONT_CSP: 'enforce',
      STORAGE_PROVIDER: 's3',
      BACKUP_EXPECTED: 'true',
      PAYMENT_PROVIDER: 'sandbox',
      EMAIL_PROVIDER: 'mock',
      SMS_PROVIDER: 'mock',
      INVOICE_PROVIDER: 'mock',
      MARKETING_PROVIDER: 'mock',
      TRUST_PROXY: '172.31.240.0/24',
      CADDY_GLOBAL_OPTIONS: 'local_certs',
      S3_PUBLIC_UPSTREAM: 'http://minio:9000',
      BACKUP_AGE_RECIPIENT: RECIPIENT,
      ALERT_EMAIL: '',
    });
  });

  it('writes rehearsal caddy env', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    expect(env).toMatchObject({
      CADDY_ENV: 'rehearsal',
      CADDY_TLS: 'auto',
      CF_TRUSTED_RANGES: '127.0.0.1/32',
      STAGING_AUTH_USER: '',
      STAGING_AUTH_HASH: '',
    });
  });

  it('gives every variable both compose files interpolate (except IMAGE_TAG, set by deploy.sh)', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    const optional = new Set([
      'IMAGE_TAG',
      'DB_APP_ROLE',
      'DB_BACKUP_ROLE',
      'PAYMENT_SANDBOX_ALLOW_REMOTE',
      'CADDY_ORIGIN_DIR',
    ]);
    const names = [
      ...composeNames('docker-compose.prod.yml'),
      ...composeNames('deploy/rehearsal/docker-compose.rehearsal.yml'),
    ].filter((name) => !optional.has(name));
    expect(names.filter((name) => !(name in env))).toEqual([]);
  });

  it('no two secrets are equal, and each is long enough', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    const values = SECRET_NAMES.map((name) => env[name]);
    expect(values.every(Boolean)).toBe(true);
    expect(new Set(values).size).toBe(values.length);
    for (const name of ['POSTGRES_PASSWORD', 'NESTO_OWNER_PASSWORD', 'NESTO_APP_PASSWORD', 'NESTO_BACKUP_PASSWORD'])
      expect(env[name].length, name).toBeGreaterThanOrEqual(24);
    for (const name of ['OTP_PEPPER', 'MARKETING_TOKEN_SECRET', 'CONTENT_PREVIEW_SECRET', 'INTERNAL_API_TOKEN'])
      expect(env[name], name).toHaveLength(48);
    for (const name of ['TOTP_ENCRYPTION_KEY', 'ORDER_TOKEN_KEY'])
      expect(Buffer.from(env[name], 'base64'), name).toHaveLength(32);
  });

  it('is fresh on every call', () => {
    const a = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    const b = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    for (const name of SECRET_NAMES) expect(a[name], name).not.toBe(b[name]);
  });

  it('connects each service as its own role with its own password', () => {
    const env = envOf(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    const url = (name) => new URL(env[name]);
    expect(url('DATABASE_URL').username).toBe('nesto_app');
    expect(decodeURIComponent(url('DATABASE_URL').password)).toBe(env.NESTO_APP_PASSWORD);
    expect(url('MIGRATE_DATABASE_URL').username).toBe('nesto_owner');
    expect(decodeURIComponent(url('MIGRATE_DATABASE_URL').password)).toBe(env.NESTO_OWNER_PASSWORD);
    expect(url('BACKUP_DATABASE_URL').username).toBe('nesto_backup');
    expect(decodeURIComponent(url('BACKUP_DATABASE_URL').password)).toBe(env.NESTO_BACKUP_PASSWORD);
    for (const name of ['DATABASE_URL', 'MIGRATE_DATABASE_URL', 'BACKUP_DATABASE_URL'])
      expect(url(name).host + url(name).pathname, name).toBe('postgres:5432/nesto');
  });

  it('refuses a recipient that is not an age public key, without echoing it', () => {
    for (const bad of ['', 'age1short', `AGE1${'q'.repeat(58)}`, `age1${'Q'.repeat(58)}`, 'AGE-SECRET-KEY-1ABC']) {
      expect(() => buildRehearsalEnv({ ageRecipient: bad })).toThrow(/age public key/);
    }
    try {
      buildRehearsalEnv({ ageRecipient: 'AGE-SECRET-KEY-1SHOULDNOTPRINT' });
    } catch (error) {
      expect(String(error)).not.toContain('SHOULDNOTPRINT');
    }
  });
});

describe('formatEnv', () => {
  it('writes NAME=value lines Compose reads as they are (no $, quotes or line breaks in a value)', () => {
    const text = formatEnv(buildRehearsalEnv({ ageRecipient: RECIPIENT }));
    for (const line of text.split('\n').filter((l) => l && !l.startsWith('#'))) {
      expect(line).toMatch(/^[A-Z][A-Z0-9_]*=/);
      const value = line.slice(line.indexOf('=') + 1);
      expect(value, line.split('=')[0]).not.toMatch(/[$'"`\r\n\\]|\s#/);
    }
  });
});

describe('writeRehearsalEnv', () => {
  it('writes the file and returns only the names', () => {
    const file = join(tempDir(), '.env.rehearsal');
    const names = writeRehearsalEnv(file, { ageRecipient: RECIPIENT });
    const text = readFileSync(file, 'utf8');
    expect(names).toContain('OTP_PEPPER');
    expect(names.every((name) => /^[A-Z][A-Z0-9_]*$/.test(name))).toBe(true);
    expect(text).toMatch(/^OTP_PEPPER=.{48}$/m);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('the CLI prints the path and the names, never a value', () => {
    const file = join(tempDir(), '.env.rehearsal');
    const cli = join(root, 'deploy', 'rehearsal', 'make-env.mjs');
    const run = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    const ok = run(['--age-recipient', RECIPIENT, '--out', file]);
    expect(ok.status).toBe(0);
    const values = readFileSync(file, 'utf8')
      .split('\n')
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => line.slice(line.indexOf('=') + 1))
      .filter((value) => value.length >= 12);
    for (const value of values) expect(ok.stdout + ok.stderr).not.toContain(value);
    expect(ok.stdout).toContain('OTP_PEPPER');
    const again = run(['--age-recipient', RECIPIENT, '--out', file]);
    expect(again.status).toBe(1);
    expect(again.stderr).toMatch(/refusing to overwrite/);
    const bad = run(['--age-recipient', 'AGE-SECRET-KEY-1NOTPRINTED', '--out', join(tempDir(), 'x')]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).not.toContain('NOTPRINTED');
  });

  it('refuses to overwrite', () => {
    const file = join(tempDir(), '.env.rehearsal');
    writeFileSync(file, 'KEEP=1\n');
    expect(() => writeRehearsalEnv(file, { ageRecipient: RECIPIENT })).toThrow(/refusing to overwrite/);
    expect(readFileSync(file, 'utf8')).toBe('KEEP=1\n');
  });
});
