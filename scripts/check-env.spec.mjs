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

const CF_LIST = join(root, 'deploy', 'cloudflare-ips.txt');
const CF_RANGES = readFileSync(CF_LIST, 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

/** Runs the check the way deploy.sh does: with the Cloudflare list as the third argument. */
function checkWithList(pairs) {
  const file = join(tempDir(), 'env');
  writeFileSync(file, formatEnv(Object.entries(pairs)));
  const r = spawnSync(process.execPath, ['-', file, COMPOSE, CF_LIST], { input: SCRIPT, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout, stderr: r.stderr };
}

/** A fake bcrypt hash in the shape `caddy hash-password` prints (made here, never a real credential). */
const BCRYPT_CHARS = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const fakeBcrypt = () =>
  `$2a$14$${Array.from({ length: 53 }, () => BCRYPT_CHARS[Math.floor(Math.random() * BCRYPT_CHARS.length)]).join('')}`;
const HASH = fakeBcrypt();

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
  // Single quotes, as env.prod.example says: Compose would expand the `$` otherwise.
  STAGING_AUTH_HASH: `'${HASH}'`,
  CADDY_TLS: 'origin',
  CADDY_ORIGIN_DIR: '/etc/nesto/origin',
  CF_TRUSTED_RANGES: CF_RANGES.join(' '),
});

/** A consistent rehearsal env (local only). */
const rehearsal = () => ({
  ...staging(),
  CADDY_ENV: 'rehearsal',
  SITE_URL: 'https://nesto.localhost',
  STOREFRONT_URL: 'https://nesto.localhost',
  SITE_HOST: 'nesto.localhost',
  NG_ALLOWED_HOSTS: 'nesto.localhost',
  ADMIN_URL: 'https://admin.nesto.localhost',
  ADMIN_HOST: 'admin.nesto.localhost',
  STAGING_AUTH_USER: '',
  STAGING_AUTH_HASH: '',
  CADDY_TLS: 'auto',
  CADDY_ORIGIN_DIR: '',
  CF_TRUSTED_RANGES: '127.0.0.1/32',
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
    expect(check(rehearsal()).code).toBe(0);
  });

  it('check-env wants STAGING_AUTH_HASH in a form Compose passes on intact, and a bcrypt shape', () => {
    // Verified with `docker compose config` / `run`: unquoted or double-quoted, `$2a`, `$14`, ... are expanded as
    // variables; single quotes are literal; `$$` is one `$` unquoted or in double quotes (but literal in single quotes).
    const escaped = HASH.replaceAll('$', '$$$$');
    for (const ok of [`'${HASH}'`, escaped, `"${escaped}"`, `'${HASH}' # note`]) {
      const r = check({ ...staging(), STAGING_AUTH_HASH: ok });
      expect(r.code, r.out).toBe(0);
    }
    const halfEscaped = escaped.replace('$$14', '$14');
    for (const bad of [HASH, `"${HASH}"`, halfEscaped, `"${halfEscaped}"`]) {
      const r = check({ ...staging(), STAGING_AUTH_HASH: bad });
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("STAGING_AUTH_HASH: Compose would expand its '$'");
      expect(r.out).not.toContain(HASH.slice(7));
    }
    for (const bad of [
      "'fake-bcrypt-hash-for-tests'",
      `'${escaped}'`,
      `'${HASH.slice(0, -1)}'`,
      `'${HASH.replace('$2a$14$', '$2x$14$')}'`,
      `'${HASH.replace('$2a$14$', '$2a$99$')}'`,
      'plainpassword',
    ]) {
      const r = check({ ...staging(), STAGING_AUTH_HASH: bad });
      expect(r.code, bad).toBe(1);
      expect(r.stderr, bad).toContain('STAGING_AUTH_HASH: must be a bcrypt hash');
      expect(r.out).not.toContain(HASH.slice(7));
    }
  });

  it('check-env requires Cloudflare ranges for staging and production, and a valid CADDY_TLS', () => {
    const none = check({ ...staging(), CF_TRUSTED_RANGES: '  ' });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('CF_TRUSTED_RANGES: missing');
    const prod = { ...staging(), APP_ENV: 'production', CADDY_ENV: 'production', SEO_INDEXING: 'true' };
    expect(check({ ...prod, CF_TRUSTED_RANGES: '' }).stderr).toContain('CF_TRUSTED_RANGES: missing');
    // Syntax is checked even without the list (a stdin run without the third argument).
    for (const bad of ['10.0.0.0', '999.1.1.1/8', '10.0.0.0/33', 'any', '10.0.0.0/8 nope'])
      expect(check({ ...staging(), CF_TRUSTED_RANGES: bad }).stderr, bad).toContain('every entry must be a CIDR');
    // The rehearsal has no Cloudflare in front: the variable is only needed by compose.
    expect(check({ ...rehearsal(), CF_TRUSTED_RANGES: '' }).code).toBe(0);
    expect(check({ ...staging(), CADDY_TLS: 'both' }).stderr).toContain('CADDY_TLS: must be origin or auto');
  });

  it('check-env wants the Origin CA certificate on staging and production', () => {
    const prod = { ...staging(), APP_ENV: 'production', CADDY_ENV: 'production', SEO_INDEXING: 'true' };
    for (const [name, env] of [
      ['staging', staging()],
      ['production', prod],
    ]) {
      expect(check(env).code, name).toBe(0);
      for (const tls of ['auto', '']) {
        const r = check({ ...env, CADDY_TLS: tls });
        expect(r.code, `${name} ${tls}`).toBe(1);
        expect(r.stderr).toContain(`CADDY_TLS: must be origin when CADDY_ENV=${name}`);
      }
      for (const dir of [
        '',
        './deploy/caddy/no-origin',
        'deploy/caddy/no-origin/',
        'C:\\repo\\deploy\\caddy\\no-origin',
      ]) {
        const r = check({ ...env, CADDY_ORIGIN_DIR: dir });
        expect(r.code, `${name} ${dir}`).toBe(1);
        expect(r.stderr).toContain(`CADDY_ORIGIN_DIR: must be the Origin CA folder when CADDY_ENV=${name}`);
        if (dir) expect(r.out).not.toContain('no-origin');
      }
    }
  });

  it('check-env keeps the rehearsal on localhost names with auto TLS', () => {
    for (const tls of ['auto', '']) expect(check({ ...rehearsal(), CADDY_TLS: tls }).code, tls).toBe(0);
    expect(
      check({
        ...rehearsal(),
        SITE_HOST: 'localhost',
        SITE_URL: 'https://localhost',
        STOREFRONT_URL: 'https://localhost',
        NG_ALLOWED_HOSTS: 'localhost',
      }).code,
    ).toBe(0);
    const origin = check({ ...rehearsal(), CADDY_TLS: 'origin' });
    expect(origin.code).toBe(1);
    expect(origin.stderr).toContain('CADDY_TLS: must be auto (or empty) when CADDY_ENV=rehearsal');
    // A rehearsal env pointed at real names would get no Cloudflare check, no login gate and no Origin CA.
    const real = check({ ...staging(), CADDY_ENV: 'rehearsal', CADDY_TLS: 'auto' });
    expect(real.code).toBe(1);
    expect(real.stderr).toContain('SITE_HOST: must be localhost or end in .localhost when CADDY_ENV=rehearsal');
    expect(real.stderr).toContain('ADMIN_HOST: must be localhost or end in .localhost when CADDY_ENV=rehearsal');
    expect(real.out).not.toContain('example.test');
    for (const host of ['localhost.example.test', 'nesto.localhost.example.test', 'evil-localhost'])
      expect(check({ ...rehearsal(), ADMIN_HOST: host, ADMIN_URL: `https://${host}` }).stderr, host).toContain(
        'ADMIN_HOST: must be localhost or end in .localhost',
      );
  });

  it('check-env wants exactly the Cloudflare list, when it has the list', () => {
    expect(checkWithList(staging())).toMatchObject({ code: 0 });
    // Order and whitespace are free.
    expect(checkWithList({ ...staging(), CF_TRUSTED_RANGES: `  ${[...CF_RANGES].reverse().join('   ')} ` }).code).toBe(
      0,
    );
    const extra = checkWithList({ ...staging(), CF_TRUSTED_RANGES: `${CF_RANGES.join(' ')} 10.0.0.0/8` });
    expect(extra.code).toBe(1);
    expect(extra.stderr).toContain('CF_TRUSTED_RANGES: every entry must be listed in deploy/cloudflare-ips.txt');
    expect(extra.stderr).not.toContain('10.0.0.0');
    const missing = checkWithList({ ...staging(), CF_TRUSTED_RANGES: CF_RANGES.slice(1).join(' ') });
    expect(missing.code).toBe(1);
    expect(missing.stderr).toContain('CF_TRUSTED_RANGES: must hold every range of deploy/cloudflare-ips.txt');
    expect(missing.stderr).not.toContain(CF_RANGES[0]);
    const both = checkWithList({ ...staging(), CF_TRUSTED_RANGES: `${CF_RANGES.slice(1).join(' ')} 10.0.0.0/8` });
    expect(both.stderr).toContain('every entry must be listed');
    expect(both.stderr).toContain('must hold every range');
    // The rehearsal is not compared with the list.
    expect(checkWithList(rehearsal()).code).toBe(0);
    // From the host the list beside the script is used by default.
    const file = join(tempDir(), 'env');
    writeFileSync(file, formatEnv(Object.entries({ ...staging(), CF_TRUSTED_RANGES: CF_RANGES[0] })));
    const host = spawnSync(process.execPath, [join(root, 'deploy', 'check-env.mjs'), file], { encoding: 'utf8' });
    expect(host.status).toBe(1);
    expect(host.stderr).toContain('must hold every range of deploy/cloudflare-ips.txt');
    const ok = join(tempDir(), 'env');
    writeFileSync(ok, formatEnv(Object.entries(staging())));
    const unreadable = spawnSync(process.execPath, ['-', ok, COMPOSE, join(tempDir(), 'nope')], {
      input: SCRIPT,
      encoding: 'utf8',
    });
    expect(unreadable.status).toBe(2);
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
