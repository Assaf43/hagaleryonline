import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Spec 9b.2 / 9b.3: text checks of the production compose file and the rehearsal overlay (no YAML parser in the
// repo's dependencies; the files keep two-space indentation, which Prettier enforces).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name) => readFileSync(join(root, name), 'utf8');
const PROD = read('docker-compose.prod.yml');
const OVERLAY = read('deploy/rehearsal/docker-compose.rehearsal.yml');
const ENV_EXAMPLE = read('deploy/env.prod.example');

/** The text without comment lines and trailing comments. */
const config = (text) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .map((line) => line.replace(/\s+#.*$/, ''))
    .join('\n');

/** The `services:` block split into { name: body } by the two-space-indented keys. */
function services(text) {
  const lines = config(text).split('\n');
  const start = lines.indexOf('services:');
  const out = {};
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (/^\S/.test(line)) break;
    const key = /^ {2}([a-z][a-z0-9-]*):\s*$/.exec(line);
    if (key) {
      current = key[1];
      out[current] = '';
    } else if (current) out[current] += `${line}\n`;
  }
  return out;
}

const prod = services(PROD);
const overlay = services(OVERLAY);
const PINNED_MINIO = [
  'bitnamilegacy/minio:2025.7.23-debian-12-r5@sha256:6dabb4a2088c9a79908de3bc05f4586c23ad2182c8908e7e3acbf61c1467fb20',
  'bitnamilegacy/minio-client:2025.7.21-debian-12-r3@sha256:73bd39f7899a0cef12b8dd5df13aa93a3ed1aaa44236542442e9ac76819ac158',
];

describe('docker-compose.prod.yml', () => {
  it('has the six services', () => {
    expect(Object.keys(prod).sort()).toEqual(['api', 'backup', 'caddy', 'migrate', 'postgres', 'web']);
  });

  it('postgres publishes no port, and only caddy publishes any', () => {
    expect(prod.postgres).not.toMatch(/^\s+ports:/m);
    for (const [name, body] of Object.entries(prod)) {
      if (name !== 'caddy') expect(body, name).not.toMatch(/^\s+(ports|expose):/m);
    }
    expect(prod.caddy).toMatch(/- '80:80'/);
    expect(prod.caddy).toMatch(/- '443:443'/);
  });

  it('every service has logging (the x-logging anchor: json-file, 10m, 5 files)', () => {
    expect(PROD).toMatch(
      /x-logging: &logging\n {2}driver: json-file\n {2}options:\n {4}max-size: 10m\n {4}max-file: '5'/,
    );
    for (const [name, body] of Object.entries(prod)) expect(body, name).toMatch(/^ {4}logging: \*logging$/m);
  });

  it('every image is ours with ${IMAGE_TAG, except the pinned postgres', () => {
    for (const [name, body] of Object.entries(prod)) {
      const image = /^ {4}image: (.+)$/m.exec(body)?.[1];
      expect(image, name).toBeTruthy();
      if (name === 'postgres') expect(image).toMatch(/^postgres:18\.\d+-bookworm@sha256:[0-9a-f]{64}$/);
      else expect(image, name).toMatch(/^nesto-(app|caddy|backup):\$\{IMAGE_TAG:\?/);
    }
  });

  it('never uses latest, MinIO or the rehearsal images', () => {
    expect(config(PROD)).not.toMatch(/:latest\b/);
    expect(config(PROD)).not.toMatch(/bitnami|minio/i);
  });

  it('restarts every long-running service; migrate runs once, only in the deploy profile', () => {
    for (const name of ['postgres', 'api', 'web', 'caddy', 'backup'])
      expect(prod[name], name).toMatch(/^ {4}restart: unless-stopped$/m);
    expect(prod.migrate).toMatch(/^ {4}restart: 'no'$/m);
    expect(prod.migrate).toMatch(/^ {4}profiles: \[deploy\]$/m);
    expect(prod.migrate).toContain(
      'npx prisma migrate deploy --config apps/api/prisma.config.ts && node apps/api/dist/cli.js apply-db-grants',
    );
    expect(prod.migrate).toMatch(/DATABASE_URL: \$\{MIGRATE_DATABASE_URL:\?/);
    // An entrypoint would stop `run --rm migrate npx prisma db seed …` from replacing the command.
    expect(prod.migrate).not.toMatch(/entrypoint:/);
  });

  it('init on every Node service', () => {
    expect(PROD).toMatch(/x-node-hardening: &node-hardening\n {2}init: true/);
    for (const name of ['migrate', 'api', 'web', 'backup']) expect(prod[name], name).toContain('<<: *node-hardening');
  });

  it('health checks: postgres, api, web, caddy; api waits for postgres, web for api', () => {
    expect(prod.postgres).toMatch(/test: \['CMD', 'pg_isready'/);
    expect(prod.api).toContain("fetch('http://localhost:3000/api/health')");
    expect(prod.api).toMatch(/interval: 10s/);
    expect(prod.web).toContain("port:4000,path:'/'");
    expect(prod.caddy).toContain('wget -qO- http://127.0.0.1:2019/config/ >/dev/null');
    expect(prod.api).toMatch(/depends_on:\n {6}postgres:\n {8}condition: service_healthy/);
    expect(prod.web).toMatch(/depends_on:\n {6}api:\n {8}condition: service_healthy/);
  });

  it('networks: edge has the fixed subnet; caddy is only on edge, postgres / backup / migrate only internal', () => {
    expect(PROD).toMatch(/edge:\n {4}ipam:\n {6}config:\n {8}- subnet: 172\.31\.240\.0\/24/);
    expect(prod.caddy).toMatch(/networks: \[edge\]/);
    for (const name of ['postgres', 'backup', 'migrate']) expect(prod[name], name).toMatch(/networks: \[internal\]/);
    for (const name of ['api', 'web']) expect(prod[name], name).toMatch(/networks: \[internal, edge\]/);
  });

  it('the web service runs the storefront server on 4000 against the api', () => {
    expect(prod.web).toContain("command: ['node', 'apps/storefront/dist/storefront/server/server.mjs']");
    expect(prod.web).toMatch(/PORT: '4000'/);
    expect(prod.web).toMatch(/API_URL: http:\/\/api:3000/);
  });

  it('least privilege: each secret reaches only its service', () => {
    const holders = (name) => Object.keys(prod).filter((s) => new RegExp(`\\$\\{${name}[:}]`).test(prod[s]));
    const expected = {
      POSTGRES_PASSWORD: ['postgres'],
      NESTO_OWNER_PASSWORD: ['postgres'],
      NESTO_APP_PASSWORD: ['postgres'],
      NESTO_BACKUP_PASSWORD: ['postgres'],
      MIGRATE_DATABASE_URL: ['migrate'],
      DATABASE_URL: ['api'],
      BACKUP_DATABASE_URL: ['backup'],
      S3_ACCESS_KEY_ID: ['api'],
      S3_SECRET_ACCESS_KEY: ['api'],
      BACKUP_S3_ACCESS_KEY_ID: ['backup'],
      BACKUP_S3_SECRET_ACCESS_KEY: ['backup'],
      // Restore-time keys: never in a running production service.
      BACKUP_READ_ACCESS_KEY_ID: [],
      BACKUP_READ_SECRET_ACCESS_KEY: [],
      TOTP_ENCRYPTION_KEY: ['api'],
      ORDER_TOKEN_KEY: ['api'],
      OTP_PEPPER: ['api'],
      MARKETING_TOKEN_SECRET: ['api'],
      CONTENT_PREVIEW_SECRET: ['api'],
      PAYMENT_SANDBOX_SECRET: ['api'],
      MARKETING_MOCK_SECRET: ['api'],
      INTERNAL_API_TOKEN: ['api', 'web'],
    };
    for (const [name, services] of Object.entries(expected)) expect(holders(name).sort(), name).toEqual(services);
    expect(PROD).not.toMatch(/env_file:/);
    const caddyVars = [...prod.caddy.matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]).sort();
    expect(caddyVars).toEqual([
      'ADMIN_HOST',
      'CADDY_GLOBAL_OPTIONS',
      'IMAGE_TAG',
      'S3_PUBLIC_BUCKET',
      'S3_PUBLIC_UPSTREAM',
      'SITE_HOST',
    ]);
  });

  it('caddy settings that must never be empty are required (an empty bucket would open /media)', () => {
    for (const name of ['SITE_HOST', 'ADMIN_HOST', 'S3_PUBLIC_BUCKET', 'S3_PUBLIC_UPSTREAM'])
      expect(prod.caddy, name).toMatch(new RegExp(`\\$\\{${name}:\\?`));
    expect(prod.caddy).toMatch(/\$\{CADDY_GLOBAL_OPTIONS:-\}/);
  });

  it('holds no literal secret: every variable value is interpolated or a plain setting', () => {
    for (const [name, body] of Object.entries(prod)) {
      for (const m of body.matchAll(/^ {6}([A-Z][A-Z0-9_]*): (.+)$/gm)) {
        const [, key, value] = m;
        if (/PASSWORD|SECRET|TOKEN|PEPPER|KEY|DATABASE_URL/.test(key))
          expect(value, `${name}.${key}`).toMatch(/^\$\{[A-Z0-9_]+(:[?-][^}]*)?\}$/);
      }
    }
    expect(PROD).not.toMatch(/postgres(ql)?:\/\/[^$\s]*:[^$\s@]+@/);
    // No long random-looking run (a key or password); image digests are the only long hex strings.
    expect(config(PROD).replace(/@sha256:[0-9a-f]{64}/g, '')).not.toMatch(/[A-Za-z0-9]{24,}/);
  });
});

describe('deploy/env.prod.example', () => {
  const lines = ENV_EXAMPLE.split('\n').filter((line) => line && !line.startsWith('#'));

  it('lists names only, never a value', () => {
    for (const line of lines) expect(line).toMatch(/^[A-Z][A-Z0-9_]*=$/);
  });

  it('lists every variable the compose file reads, each with a comment', () => {
    const names = new Set(lines.map((line) => line.slice(0, -1)));
    const used = [...new Set([...config(PROD).matchAll(/\$\{([A-Z0-9_]+)/g)].map((m) => m[1]))];
    expect(used.filter((name) => !names.has(name))).toEqual([]);
    const text = ENV_EXAMPLE.split('\n');
    for (const name of names) {
      const i = text.indexOf(`${name}=`);
      // The line above is a comment, or a name of the same group whose comment covers both.
      let j = i - 1;
      while (j >= 0 && /^[A-Z][A-Z0-9_]*=$/.test(text[j])) j--;
      expect(text[j], name).toMatch(/^# /);
    }
  });
});

describe('deploy/rehearsal/docker-compose.rehearsal.yml', () => {
  it('adds minio and minio-setup with the pinned frozen images, and says so', () => {
    expect(overlay.minio).toContain(`image: ${PINNED_MINIO[0]}`);
    expect(overlay['minio-setup']).toContain(`image: ${PINNED_MINIO[1]}`);
    expect(OVERLAY).toMatch(/FROZEN TEST DOUBLE, LOCAL ONLY/);
  });

  it('only images: the two pinned MinIO builds; no latest', () => {
    const images = [...config(OVERLAY).matchAll(/^ {4}image: (\S+)$/gm)].map((m) => m[1]);
    expect(images.sort()).toEqual([...PINNED_MINIO].sort());
    expect(config(OVERLAY)).not.toMatch(/:latest\b/);
  });

  it('publishes only the MinIO console, on 127.0.0.1:9001', () => {
    const ports = [...config(OVERLAY).matchAll(/^ {6}- '([^']+)'$/gm)].map((m) => m[1]).filter((p) => /:\d+$/.test(p));
    expect(ports).toEqual(['127.0.0.1:9001:9001']);
    expect(overlay['minio-setup']).not.toMatch(/ports:/);
  });

  it('every service it defines has logging', () => {
    for (const name of ['minio', 'minio-setup']) expect(overlay[name], name).toMatch(/^ {4}logging:/m);
  });

  it('minio-setup runs the mounted script once and waits for a healthy minio', () => {
    const setup = overlay['minio-setup'];
    expect(setup).toContain("entrypoint: ['sh']");
    expect(setup).toContain('./deploy/rehearsal/minio-setup.sh:/setup/minio-setup.sh:ro');
    expect(setup).toMatch(/restart: 'no'/);
    expect(setup).toMatch(/minio:\n {8}condition: service_healthy/);
    expect(overlay.minio).toContain("entrypoint: ['minio']");
    expect(overlay.minio).toMatch(/healthcheck:/);
  });

  it('holds no literal secret', () => {
    for (const m of config(OVERLAY).matchAll(/^ {6}([A-Z][A-Z0-9_]*): (.+)$/gm)) {
      const [, key, value] = m;
      expect(value, key).toMatch(/^\$\{[A-Z0-9_]+(:[?-][^}]*)?\}$/);
    }
  });
});

describe('deploy/rehearsal/minio-setup.sh', () => {
  const script = read('deploy/rehearsal/minio-setup.sh');

  it('is POSIX sh with set -eu, never set -x, LF only', () => {
    expect(script.startsWith('#!/bin/sh\n')).toBe(true);
    expect(script).toMatch(/^set -eu$/m);
    expect(config(script)).not.toMatch(/set -[a-z]*x/);
    expect(script).not.toContain('\r');
  });

  it('never puts a secret on a command line or prints one', () => {
    // Secrets reach mc only through MC_HOST_local (env) and printf (a shell builtin) into its stdin.
    for (const line of config(script).split('\n')) {
      const command = line.includes('|') ? line.slice(line.lastIndexOf('|')) : line;
      if (/\bmcx?\b/.test(command)) expect(command, line).not.toMatch(/PASSWORD|SECRET|"\$2"/);
    }
    expect(script).toContain(`printf '%s\\n' "$2" | mcx admin user add local "$1"`);
    expect(script).not.toMatch(/echo[^\n]*(PASSWORD|SECRET)/);
  });

  it('is idempotent: existing buckets, policies, users and attachments are not errors', () => {
    expect(script).toContain('mb --ignore-existing');
    expect(script).toContain('ilm import');
    expect(script).not.toContain('ilm rule add');
    expect(script).toMatch(/grep -qi 'already'/);
  });

  it('the backup writer may only put objects into the backup bucket', () => {
    const writer = /backup-writer\.json" <<EOF\n([\s\S]*?)\nEOF/.exec(script)?.[1] ?? '';
    expect(writer).toContain(
      '"Action": ["s3:PutObject", "s3:AbortMultipartUpload"],\n      "Resource": ["arn:aws:s3:::$backups/*"]',
    );
    expect(writer).not.toMatch(/Delete|Versioning|Lifecycle|Policy|\$backups"/);
    expect(writer).not.toMatch(/"s3:[A-Za-z]*\*"/);
  });

  it('anonymous access is GetObject on the public bucket only (no listing)', () => {
    expect(script).not.toContain('anonymous set download');
    const pub = /public-read\.json" <<EOF\n([\s\S]*?)\nEOF/.exec(script)?.[1] ?? '';
    expect(pub).toContain('"Action": ["s3:GetObject"]');
    expect(pub).toContain('"Resource": ["arn:aws:s3:::$pub/*"]');
    expect(script).toContain('anonymous set-json "$work/public-read.json" "local/$pub"');
    expect(script).toContain('anonymous set none "local/$priv"');
    expect(script).toContain('anonymous set none "local/$backups"');
  });

  it('versions the backup bucket, so an overwrite by the writer keeps the old version', () => {
    expect(script).toContain('mcx version enable "local/$backups"');
  });

  it('lifecycle: current db/ objects after 30 days, noncurrent versions after 30 days, nothing else', () => {
    const lifecycle = /lifecycle\.json" <<'EOF'\n([\s\S]*?)\nEOF/.exec(script)?.[1] ?? '';
    const rules = JSON.parse(lifecycle).Rules;
    expect(rules).toEqual([
      { ID: 'expire-db-dumps', Status: 'Enabled', Filter: { Prefix: 'db/' }, Expiration: { Days: 30 } },
      {
        ID: 'expire-noncurrent-versions',
        Status: 'Enabled',
        Filter: { Prefix: '' },
        NoncurrentVersionExpiration: { NoncurrentDays: 30 },
      },
    ]);
  });
});
