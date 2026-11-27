import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Spec 9c (decision 106, NFR-12): the real Caddyfile in a real Caddy behind a fake Cloudflare. Caddy runs on a
// throwaway Docker network with scripts/fixtures/echo-upstream.mjs as `api` and `web`; the requests come from
// client containers on the same network (no host port is published). Two clients: `cf` is listed in
// CF_TRUSTED_RANGES (it plays a Cloudflare edge), `direct` is not (a caller that reaches the origin directly).
//
// Opt-in: runs only with docker and CADDY_TEST_IMAGE set or CADDY_PROXY_SPEC=1 (plain `npm test` skips it).
// Image: CADDY_TEST_IMAGE (CI's docker job passes the nesto-caddy it built, with its own /etc/caddy files). Without
// it the spec builds the Dockerfile's caddy-builder stage (stock Caddy cannot run the rate_limit directive) into a
// small local image and mounts deploy/caddy/ over /etc/caddy. Every container and network is named
// nesto9c1-cp-<pid>-… and removed afterwards; images the spec builds are removed unless CADDY_TEST_KEEP_IMAGES=1.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCKERFILE = readFileSync(join(root, 'Dockerfile'), 'utf8');

function docker(args, options = {}) {
  return spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 << 20, ...options });
}
function must(args, options) {
  const r = docker(args, options);
  if (r.status !== 0)
    throw new Error(`docker ${args.slice(0, 2).join(' ')} failed (${r.status}): ${r.stderr || r.error}`);
  return r.stdout.trim();
}

const dockerUp = docker(['info', '--format', '{{.ServerVersion}}'], { timeout: 30_000 }).status === 0;
// Opt-in: it builds and starts containers, so plain `npm test` never runs it.
const skip = !dockerUp || !(process.env.CADDY_TEST_IMAGE || process.env.CADDY_PROXY_SPEC === '1');

const ID = `nesto9c1-cp-${process.pid}`;
const NET = `${ID}-net`;
const names = {
  echo: `${ID}-echo`,
  cf: `${ID}-client-cf`,
  direct: `${ID}-client-direct`,
  prod: `${ID}-caddy-prod`,
  staging: `${ID}-caddy-staging`,
  empty: `${ID}-caddy-empty-env`,
};
const BUILDER_IMAGE = 'nesto9c1-caddy-builder:local';
const LOCAL_IMAGE = 'nesto9c1-caddy-test:local';
const builtImages = [];

const NODE_IMAGE = DOCKERFILE.match(/^FROM (node:\S+@sha256:[0-9a-f]{64}) AS base$/m)?.[1];
const CADDY_BASE = DOCKERFILE.match(/^FROM (caddy:\S+@sha256:[0-9a-f]{64}) AS caddy$/m)?.[1];

// Test-only credentials for the staging gate; the bcrypt hash is made at test time and never stored.
const GATE_USER = 'nesto-test-user';
const GATE_PASSWORD = 'not-a-real-password-test-only';
const GATE_AUTH = `Basic ${Buffer.from(`${GATE_USER}:${GATE_PASSWORD}`).toString('base64')}`;

const PROD = { site: 'shop.example.test', admin: 'admin.example.test' };
const STAGING = { site: 'shop-staging.example.test', admin: 'admin-staging.example.test' };
const MB = 1024 * 1024;

let image;
let mounts = [];
const ip = {};

function caddyEnv(hosts, extra) {
  const env = {
    SITE_HOST: hosts.site,
    ADMIN_HOST: hosts.admin,
    S3_PUBLIC_BUCKET: 'nesto-media-public',
    // The echo stands in for the bucket too, so the spec sees what /media sends to the object store.
    S3_PUBLIC_UPSTREAM: 'http://api:3000',
    CADDY_GLOBAL_OPTIONS: 'local_certs',
    CADDY_TLS: 'auto',
    STAGING_AUTH_USER: '',
    STAGING_AUTH_HASH: '',
    ...extra,
  };
  return Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
}

function ipOf(name) {
  return must(['inspect', '-f', `{{(index .NetworkSettings.Networks "${NET}").IPAddress}}`, name]);
}

// One or more HTTPS requests from a client container (TLS verification off: Caddy's local CA). node:https rather
// than fetch: when Caddy answers 413 and closes the connection in the middle of a large upload, the answer is
// still read instead of surfacing only as a write error.
const CLIENT_SCRIPT = `
import { request } from 'node:https';
const o = JSON.parse(process.argv[1]);
function once(headers) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = request(o.url, { method: o.method ?? 'GET', headers, rejectUnauthorized: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => finish({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString() }));
      res.on('error', () => finish({ status: res.statusCode, headers: res.headers, text: '' }));
    });
    req.on('error', (e) => setTimeout(() => finish({ error: String(e.code ?? e.message) }), 200));
    if (o.bodyBytes) {
      headers['content-length'] = o.bodyBytes;
      const chunk = Buffer.alloc(64 * 1024, 97);
      let left = o.bodyBytes;
      const pump = () => {
        while (left > 0 && !done) {
          const n = Math.min(left, chunk.length);
          left -= n;
          if (!req.write(n === chunk.length ? chunk : chunk.subarray(0, n))) return req.once('drain', pump);
        }
        req.end();
      };
      pump();
    } else req.end();
  });
}
const out = [];
for (let i = 0; i < (o.repeat ?? 1); i++) {
  const headers = { ...(o.headers ?? {}) };
  if (o.cfPrefix) headers['CF-Connecting-IP'] = o.cfPrefix + ((i % 250) + 1);
  if (o.bodyBytes) headers['content-length'] = String(o.bodyBytes);
  let r;
  for (let tries = o.waitReady ? 120 : 1; tries > 0; tries--) {
    r = await once(headers);
    if (!o.waitReady || r.status === 200) break;
    await new Promise((s) => setTimeout(s, 500));
  }
  out.push(o.statusOnly ? { status: r.status, error: r.error } : r);
}
console.log(JSON.stringify(out));
`;

function requests(client, options) {
  const r = must(['exec', names[client], 'node', '--input-type=module', '-e', CLIENT_SCRIPT, JSON.stringify(options)], {
    timeout: 180_000,
  });
  return JSON.parse(r.split('\n').pop());
}
const request = (client, options) => requests(client, options)[0];
/** What the echo upstream saw, or null when the request never reached it. */
function echoed(res) {
  try {
    return JSON.parse(res.text);
  } catch {
    return null;
  }
}

function cleanup() {
  for (const name of Object.values(names)) docker(['rm', '-fv', name]);
  docker(['network', 'rm', NET]);
}

describe.skipIf(skip)('Caddy behind Cloudflare (real Caddy, Docker)', () => {
  beforeAll(() => {
    expect(NODE_IMAGE, 'node base image in the Dockerfile').toBeTruthy();
    expect(CADDY_BASE, 'caddy runtime image in the Dockerfile').toBeTruthy();
    cleanup();

    if (process.env.CADDY_TEST_IMAGE) {
      image = process.env.CADDY_TEST_IMAGE;
    } else {
      must(['build', '--target', 'caddy-builder', '-t', BUILDER_IMAGE, '.'], { cwd: root, timeout: 1_200_000 });
      builtImages.push(BUILDER_IMAGE);
      must(['build', '-t', LOCAL_IMAGE, '-'], {
        input: `FROM ${CADDY_BASE}\nCOPY --from=${BUILDER_IMAGE} /usr/bin/caddy /usr/bin/caddy\n`,
        timeout: 300_000,
      });
      builtImages.push(LOCAL_IMAGE);
      image = LOCAL_IMAGE;
      mounts = ['-v', `${join(root, 'deploy', 'caddy')}:/etc/caddy:ro`];
    }

    const hash = must(['run', '--rm', image, 'caddy', 'hash-password', '--plaintext', GATE_PASSWORD]).split('\n').pop();
    expect(hash).toMatch(/^\$2[aby]\$/);

    must(['network', 'create', NET]);
    const fixtures = ['-v', `${join(root, 'scripts', 'fixtures')}:/fixtures:ro`];
    must([
      'run',
      '-d',
      '--name',
      names.echo,
      '--network',
      NET,
      '--network-alias',
      'api',
      '--network-alias',
      'web',
      ...fixtures,
      NODE_IMAGE,
      'node',
      '/fixtures/echo-upstream.mjs',
    ]);
    for (const client of ['cf', 'direct'])
      must(['run', '-d', '--name', names[client], '--network', NET, NODE_IMAGE, 'sleep', 'infinity']);
    ip.cf = ipOf(names.cf);
    ip.direct = ipOf(names.direct);

    // Only the `cf` client is a trusted hop. Two ranges, so the space-joined list is checked too.
    must([
      'run',
      '-d',
      '--name',
      names.prod,
      '--network',
      NET,
      '--network-alias',
      PROD.site,
      '--network-alias',
      PROD.admin,
      ...mounts,
      ...caddyEnv(PROD, { CADDY_ENV: 'production', CF_TRUSTED_RANGES: `198.51.100.0/24 ${ip.cf}/32` }),
      image,
    ]);
    must([
      'run',
      '-d',
      '--name',
      names.staging,
      '--network',
      NET,
      '--network-alias',
      STAGING.site,
      '--network-alias',
      STAGING.admin,
      ...mounts,
      ...caddyEnv(STAGING, {
        CADDY_ENV: 'staging',
        CF_TRUSTED_RANGES: '127.0.0.1/32',
        STAGING_AUTH_USER: GATE_USER,
        STAGING_AUTH_HASH: hash,
      }),
      image,
    ]);

    for (const host of [PROD.site, PROD.admin, STAGING.site]) {
      const res = request('direct', { url: `https://${host}/api/health`, waitReady: true });
      if (res.status !== 200) {
        const logs = docker(['logs', '--tail', '30', host === STAGING.site ? names.staging : names.prod]);
        throw new Error(
          `Caddy did not come up for ${host}: ${JSON.stringify(res).slice(0, 300)}\n${logs.stdout}${logs.stderr}`,
        );
      }
    }
  }, 1_800_000);

  afterAll(() => {
    cleanup();
    if (!process.env.CADDY_TEST_KEEP_IMAGES) for (const name of builtImages.reverse()) docker(['rmi', name]);
  }, 120_000);

  const spoof = { 'CF-Connecting-IP': '203.0.113.7', 'X-Forwarded-For': '198.51.100.9' };

  it('untrusted source: CF-Connecting-IP and X-Forwarded-For ignored', () => {
    for (const path of ['/api/x', '/']) {
      const seen = echoed(request('direct', { url: `https://${PROD.site}${path}`, headers: spoof }));
      expect(seen.port).toBe(path === '/' ? 4000 : 3000);
      expect(seen.headers['x-forwarded-for']).toBe(ip.direct);
      expect(seen.headers['cf-connecting-ip']).toBeUndefined();
    }
    const admin = echoed(request('direct', { url: `https://${PROD.admin}/api/x`, headers: spoof }));
    expect(admin.headers['x-forwarded-for']).toBe(ip.direct);
  }, 60_000);

  it('trusted source: CF-Connecting-IP used', () => {
    for (const path of ['/api/x', '/']) {
      const seen = echoed(
        request('cf', { url: `https://${PROD.site}${path}`, headers: { 'CF-Connecting-IP': '203.0.113.7' } }),
      );
      expect(seen.headers['x-forwarded-for']).toBe('203.0.113.7');
      expect(seen.headers['cf-connecting-ip']).toBeUndefined();
    }
    const admin = echoed(
      request('cf', { url: `https://${PROD.admin}/api/x`, headers: { 'CF-Connecting-IP': '203.0.113.7' } }),
    );
    expect(admin.headers['x-forwarded-for']).toBe('203.0.113.7');
    // A trusted hop without the header is itself the client.
    expect(echoed(request('cf', { url: `https://${PROD.site}/api/x` })).headers['x-forwarded-for']).toBe(ip.cf);
  }, 60_000);

  it('client X-Forwarded-For overwritten, not appended', () => {
    const viaCf = echoed(request('cf', { url: `https://${PROD.site}/api/x`, headers: spoof }));
    expect(viaCf.headers['x-forwarded-for']).toBe('203.0.113.7');
    const direct = echoed(
      request('direct', { url: `https://${PROD.site}/`, headers: { 'X-Forwarded-For': '198.51.100.9, 10.0.0.1' } }),
    );
    expect(direct.headers['x-forwarded-for']).toBe(ip.direct);
  }, 60_000);

  it('client X-Forwarded-Host replaced by the request host, also from a trusted source', () => {
    // Caddy passes a trusted hop's X-Forwarded-Host on by default, and Cloudflare forwards the client's own.
    const evil = { 'X-Forwarded-Host': 'evil.example.test' };
    for (const source of ['direct', 'cf']) {
      for (const [host, path] of [
        [PROD.site, '/api/x'],
        [PROD.site, '/'],
        [PROD.admin, '/api/x'],
      ]) {
        const seen = echoed(request(source, { url: `https://${host}${path}`, headers: evil }));
        expect(seen.headers['x-forwarded-host'], `${source} ${host}${path}`).toBe(host);
      }
    }
  }, 60_000);

  it('webhook rate limit: one bucket per real client, a spoofed header buys no new bucket', () => {
    const url = `https://${PROD.site}/api/payments/webhook`;
    // Through Cloudflare: 121 calls from one visitor hit the limit, a second visitor still gets through.
    const one = requests('cf', {
      url,
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.50' },
      repeat: 121,
      statusOnly: true,
    });
    expect(one.slice(0, 120).every((r) => r.status === 200)).toBe(true);
    expect(one[120].status).toBe(429);
    expect(request('cf', { url, method: 'POST', headers: { 'CF-Connecting-IP': '203.0.113.51' } }).status).toBe(200);
    // Directly: a new CF-Connecting-IP on every call still lands in the caller's one bucket.
    const direct = requests('direct', { url, method: 'POST', cfPrefix: '192.0.2.', repeat: 121, statusOnly: true });
    expect(direct[120].status).toBe(429);
  }, 180_000);

  it('staging: 401 without auth, 200 on /api/health and /robots.txt, X-Robots-Tag present', () => {
    for (const host of [STAGING.site, STAGING.admin]) {
      const gated = request('direct', { url: `https://${host}/api/x` });
      expect(gated.status, host).toBe(401);
      expect(gated.headers['www-authenticate']).toMatch(/^Basic/);
      expect(gated.headers['x-robots-tag']).toBe('noindex, nofollow');
      expect(gated.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(gated.headers.server).toBeUndefined();
      const wrong = request('direct', {
        url: `https://${host}/api/x`,
        headers: { Authorization: `Basic ${Buffer.from(`${GATE_USER}:wrong`).toString('base64')}` },
      });
      expect(wrong.status).toBe(401);
      const health = request('direct', { url: `https://${host}/api/health` });
      expect(health.status).toBe(200);
      expect(health.headers['x-robots-tag']).toBe('noindex, nofollow');
    }
    for (const path of ['/', '/product/alba'])
      expect(request('direct', { url: `https://${STAGING.site}${path}` }).status).toBe(401);
    // The exemption is matched on the raw request: an encoded path that only cleans to an exempt one stays gated.
    for (const path of ['/x/%2e%2e%2frobots.txt', '/api/a%2f..%2fhealth', '/x/..%2frobots.txt', '/robots.txt/x'])
      expect(request('direct', { url: `https://${STAGING.site}${path}` }).status, path).toBe(401);
    expect(request('direct', { url: `https://${STAGING.site}/api/health?probe=1` }).status).toBe(200);
    const robots = request('direct', { url: `https://${STAGING.site}/robots.txt` });
    expect(robots.status).toBe(200);
    expect(echoed(robots).port).toBe(4000);
    expect(robots.headers['x-robots-tag']).toBe('noindex, nofollow');
    const signedIn = request('direct', { url: `https://${STAGING.site}/`, headers: { Authorization: GATE_AUTH } });
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers['x-robots-tag']).toBe('noindex, nofollow');
    // The gate password stops at Caddy: the upstream never sees the Authorization header.
    expect(echoed(signedIn).port).toBe(4000);
    expect(echoed(signedIn).headers.authorization).toBeUndefined();
  }, 60_000);

  it('/media sends no visitor IP to the object store', () => {
    for (const client of ['cf', 'direct']) {
      const res = request(client, { url: `https://${PROD.site}/media/products/a.webp`, headers: spoof });
      const seen = echoed(res);
      expect(seen.url).toBe('/nesto-media-public/products/a.webp');
      expect(seen.headers['x-forwarded-for']).toBeUndefined();
      expect(seen.headers['cf-connecting-ip']).toBeUndefined();
    }
  }, 60_000);

  it('production: no auth, no X-Robots-Tag', () => {
    for (const path of ['/', '/api/x', '/robots.txt']) {
      const res = request('direct', { url: `https://${PROD.site}${path}` });
      expect(res.status, path).toBe(200);
      expect(res.headers['www-authenticate']).toBeUndefined();
      expect(res.headers['x-robots-tag']).toBeUndefined();
    }
    // The admin keeps its own noindex from admin_headers, and no gate.
    const admin = request('direct', { url: `https://${PROD.admin}/api/x` });
    expect(admin.status).toBe(200);
    expect(admin.headers['www-authenticate']).toBeUndefined();
  }, 60_000);

  it('HSTS has includeSubDomains (also on Caddy-made errors), no Server, blocked routes still 404', () => {
    for (const host of [PROD.site, PROD.admin]) {
      const res = request('direct', { url: `https://${host}/api/x` });
      expect(res.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(res.headers.server).toBeUndefined();
      const blocked = request('direct', { url: `https://${host}/api/internal/error-events` });
      expect(blocked.status).toBe(404);
      expect(echoed(blocked)).toBeNull();
      expect(blocked.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    }
    const tooBig = request('direct', { url: `https://${PROD.site}/api/cart`, method: 'POST', bodyBytes: 2 * MB });
    expect(tooBig.status).toBe(413);
    expect(tooBig.headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
    expect(tooBig.headers.server).toBeUndefined();
  }, 60_000);

  it('site 2 MB JSON → 413, damaged 40 MB → reaches upstream', () => {
    const MIB = 1024 * 1024;
    const json = { 'content-type': 'application/json' };
    expect(
      request('direct', {
        url: `https://${PROD.site}/api/cart/items`,
        method: 'POST',
        headers: json,
        bodyBytes: 2 * MB,
      }).status,
    ).toBe(413);
    const small = request('direct', {
      url: `https://${PROD.site}/api/cart/items`,
      method: 'POST',
      headers: json,
      bodyBytes: 900 * 1024,
    });
    expect(echoed(small).bodyBytes).toBe(900 * 1024);
    const damaged = request('direct', {
      url: `https://${PROD.site}/api/support/damaged`,
      method: 'POST',
      bodyBytes: 40 * MB,
    });
    expect(damaged.status).toBe(200);
    expect(echoed(damaged).bodyBytes).toBe(40 * MB);
    // Five photos at the API's 10 MiB cap plus multipart overhead still pass (Caddy's MB is 1000 x 1000 bytes).
    const fullReport = 5 * 10 * MIB + 64 * 1024;
    const full = request('direct', {
      url: `https://${PROD.site}/api/support/damaged`,
      method: 'POST',
      bodyBytes: fullReport,
    });
    expect(full.status).toBe(200);
    expect(echoed(full).bodyBytes).toBe(fullReport);
    expect(
      request('direct', { url: `https://${PROD.site}/api/support/damaged`, method: 'POST', bodyBytes: 56_000_000 })
        .status,
    ).toBe(413);
    // The large limit is bound to the raw path: an encoded path that only cleans to it keeps the 1MB limit.
    for (const path of ['/x/..%2fapi/support/damaged', '/api/support/damaged/x', '/api/support/%64amaged'])
      expect(
        request('direct', { url: `https://${PROD.site}${path}`, method: 'POST', bodyBytes: 2 * MB }).status,
        path,
      ).toBe(413);
    expect(
      request('direct', { url: `https://${PROD.site}/api/support/damaged?x=1`, method: 'POST', bodyBytes: 2 * MB })
        .status,
    ).toBe(200);
    // The webhooks keep their own 64 KB.
    expect(
      request('cf', {
        url: `https://${PROD.site}/api/marketing/webhook`,
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.60' },
        bodyBytes: 70_000,
      }).status,
    ).toBe(413);
  }, 120_000);

  it('admin 17 MB → 413', () => {
    const url = `https://${PROD.admin}/api/admin/catalog/products/1/images`;
    expect(request('direct', { url, method: 'POST', bodyBytes: 17 * MB }).status).toBe(413);
    // A 15 MiB photo (IMAGE_UPLOAD.maxBytes) plus multipart overhead passes the 16MB (16 000 000 bytes) limit.
    const photoBytes = 15 * 1024 * 1024 + 64 * 1024;
    const photo = request('direct', { url, method: 'POST', bodyBytes: photoBytes });
    expect(echoed(photo).bodyBytes).toBe(photoBytes);
  }, 120_000);

  /** Starts Caddy in the foreground; a config error ends it at once, a good config would run until the timeout. */
  function start(extra) {
    const r = docker(
      [
        'run',
        '--name',
        names.empty,
        '--network',
        NET,
        ...mounts,
        ...caddyEnv(PROD, { CF_TRUSTED_RANGES: '127.0.0.1/32', ...extra }),
        image,
      ],
      { timeout: 60_000 },
    );
    docker(['rm', '-fv', names.empty]);
    expect(r.error, 'Caddy kept running').toBeUndefined();
    expect(r.status).not.toBe(0);
    return `${r.stdout}${r.stderr}`;
  }

  it('empty CADDY_ENV fails to start', () => {
    expect(start({ CADDY_ENV: '' })).toContain('env-.caddy');
    expect(start({ CADDY_ENV: 'production', CADDY_TLS: '' })).toContain('tls-.caddy');
  }, 150_000);

  it('staging without the gate credentials fails to start', () => {
    expect(start({ CADDY_ENV: 'staging' })).toContain('username and password cannot be empty');
  }, 90_000);
});
