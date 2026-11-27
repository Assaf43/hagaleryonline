import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { formatEnv, writeRehearsalEnv } from '../deploy/rehearsal/make-env.mjs';

// deploy/check-env.mjs (spec 9c, NFR-12): the cross-checks of one env file before deploy.sh changes anything.
// It runs the way deploy.sh runs it in the image: the script on stdin, `node - <env-file> [compose-file]`.
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = readFileSync(join(root, 'deploy', 'check-env.mjs'), 'utf8');
const COMPOSE = join(root, 'docker-compose.prod.yml');
const RECIPIENT = `age1${'q'.repeat(58)}`;

let dirs = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-env-'));
  dirs.push(dir);
  return dir;
};

/** Runs the check on an env file written from `pairs` (or an existing file); returns the exit code and the output. */
function check(pairs, { compose = COMPOSE, file } = {}) {
  const envFile = file ?? join(tempDir(), 'env');
  if (!file) writeFileSync(envFile, formatEnv(Object.entries(pairs)));
  const args = compose === null ? [envFile] : [envFile, compose];
  const r = spawnSync(process.execPath, ['-', ...args], { input: SCRIPT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

/** A consistent staging env, the keys check-env reads. */
const staging = () => ({
  APP_ENV: 'staging',
  CADDY_ENV: 'staging',
  SEO_INDEXING: 'false',
  SITE_URL: 'https://staging.example.test',
  STOREFRONT_URL: 'https://staging.example.test',
  SITE_HOST: 'staging.example.test',
  NG_ALLOWED_HOSTS: 'staging.example.test',
  ADMIN_URL: 'https://admin-staging.example.test',
  ADMIN_HOST: 'admin-staging.example.test',
  TRUST_PROXY: '172.31.240.0/24',
  STAGING_AUTH_USER: 'reviewer',
  STAGING_AUTH_HASH: 'fake-bcrypt-hash-for-tests',
});

describe('deploy/check-env.mjs', () => {
  it('passes a consistent staging env, and a production one', () => {
    expect(check(staging())).toMatchObject({ code: 0 });
    const prod = {
      ...staging(),
      APP_ENV: 'production',
      CADDY_ENV: 'production',
      SEO_INDEXING: 'true',
      STAGING_AUTH_USER: '',
      STAGING_AUTH_HASH: '',
    };
    const r = check(prod);
    expect(r.code, r.out).toBe(0);
    expect(r.stdout).toContain('check-env: ok');
    // APP_ENV may be left empty: compose defaults it to production.
    expect(check({ ...prod, APP_ENV: '' }).code).toBe(0);
  });

  it('check-env flags host mismatch', () => {
    const r = check({
      ...staging(),
      SITE_URL: 'https://other.example.test',
      STOREFRONT_URL: 'https://third.example.test',
      NG_ALLOWED_HOSTS: 'www.example.test, other.example.test',
      ADMIN_HOST: 'admin.example.test',
    });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('SITE_HOST: must be the host of SITE_URL');
    expect(r.stderr).toContain('SITE_HOST: must be the host of STOREFRONT_URL');
    expect(r.stderr).toContain('NG_ALLOWED_HOSTS: must list SITE_HOST');
    expect(r.stderr).toContain('ADMIN_HOST: must be the host of ADMIN_URL');
    expect(r.out).not.toContain('example.test');
  });

  it('lists every problem at once: TRUST_PROXY, CADDY_ENV and the production switches', () => {
    const r = check({ ...staging(), TRUST_PROXY: '172.18.0.0/16', CADDY_ENV: 'prod' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('TRUST_PROXY: must be the edge subnet of docker-compose.prod.yml');
    expect(r.stderr).toContain('CADDY_ENV: must be production, staging or rehearsal');
    const mixed = check({ ...staging(), CADDY_ENV: 'production' });
    expect(mixed.code).toBe(1);
    expect(mixed.stderr).toContain('CADDY_ENV, APP_ENV: production on both or on neither');
    const seo = check({ ...staging(), SEO_INDEXING: 'true' });
    expect(seo.code).toBe(1);
    expect(seo.stderr).toContain('SEO_INDEXING: true exactly when APP_ENV is production');
    const missing = check({});
    expect(missing.code).toBe(1);
    for (const name of [
      'SITE_HOST',
      'NG_ALLOWED_HOSTS',
      'SITE_URL',
      'STOREFRONT_URL',
      'ADMIN_HOST',
      'ADMIN_URL',
      'TRUST_PROXY',
      'CADDY_ENV',
    ])
      expect(missing.stderr, name).toContain(`${name}: missing`);
  });

  it('check-env flags staging without auth', () => {
    const r = check({ ...staging(), STAGING_AUTH_USER: '', STAGING_AUTH_HASH: '  ' });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('STAGING_AUTH_USER: required when CADDY_ENV=staging');
    expect(r.stderr).toContain('STAGING_AUTH_HASH: required when CADDY_ENV=staging');
    // The rehearsal has no login gate.
    expect(check({ ...staging(), CADDY_ENV: 'rehearsal', STAGING_AUTH_USER: '', STAGING_AUTH_HASH: '' }).code).toBe(0);
  });

  it('check-env never prints values', () => {
    const sentinel = 'SENTINEL-check-env-value';
    const env = {};
    for (const name of Object.keys(staging())) env[name] = `${sentinel}-${name}`;
    env.SITE_URL = `https://${sentinel.toLowerCase()}.example.test`;
    env.TRUST_PROXY = `${sentinel}/24`;
    const r = check(env);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).not.toMatch(/sentinel/i);
    expect(r.stderr).toMatch(/^- [A-Z_, ]+: /m);
  });

  it('check-env passes the rehearsal env', () => {
    const file = join(tempDir(), '.env.rehearsal');
    writeRehearsalEnv(file, { ageRecipient: RECIPIENT });
    const r = check(null, { file });
    expect(r.code, r.out).toBe(0);
  });

  it('reads quoted values, export lines and comments as Compose does', () => {
    const dir = tempDir();
    const file = join(dir, 'env');
    const lines = Object.entries(staging()).map(([k, v], i) =>
      i === 0 ? `export ${k}=${v}` : i === 1 ? `${k}="${v}"` : i === 2 ? `${k}='${v}' # note` : `${k}=${v}`,
    );
    writeFileSync(file, `# comment\n\n${lines.join('\r\n')}\n`);
    const r = check(null, { file });
    expect(r.code, r.out).toBe(0);
  });

  it('fails clearly when the edge subnet cannot be read or a file is missing', () => {
    const dir = tempDir();
    const broken = join(dir, 'compose.yml');
    writeFileSync(broken, 'networks:\n  edge: {}\nservices: {}\n');
    const r = check(staging(), { compose: broken });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('could not read the edge subnet');
    const noEnv = check(null, { file: join(dir, 'nope') });
    expect(noEnv.code).toBe(2);
    expect(noEnv.stderr).toContain('cannot read the env file');
    const usage = spawnSync(process.execPath, ['-'], { input: SCRIPT, encoding: 'utf8' });
    expect(usage.status).toBe(2);
    expect(usage.stderr).toContain('Usage');
  });

  it('defaults the compose file to docker-compose.prod.yml at the repo root', () => {
    const file = join(tempDir(), 'env');
    writeFileSync(file, formatEnv(Object.entries(staging())));
    const r = spawnSync(process.execPath, [join(root, 'deploy', 'check-env.mjs'), file], {
      encoding: 'utf8',
      cwd: tmpdir(),
    });
    expect(r.status, `${r.stdout}${r.stderr}`).toBe(0);
  });

  it('reads the subnet from the compose file, not a constant', () => {
    const dir = tempDir();
    const other = join(dir, 'compose.yml');
    writeFileSync(
      other,
      readFileSync(COMPOSE, 'utf8').replace('subnet: 172.31.240.0/24', "subnet: '10.9.8.0/24' # moved"),
    );
    expect(check(staging(), { compose: other }).code).toBe(1);
    expect(check({ ...staging(), TRUST_PROXY: '10.9.8.0/24' }, { compose: other }).code).toBe(0);
  });
});
