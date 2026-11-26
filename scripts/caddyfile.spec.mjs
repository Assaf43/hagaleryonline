import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'caddy');
const text = readFileSync(join(dir, 'Caddyfile'), 'utf8');
// Comments never count as configuration.
const config = text
  .split('\n')
  .filter((line) => !line.trim().startsWith('#'))
  .join('\n');

// Body of the first `<opener> {` block, brace-aware (placeholders like {path} included).
function block(source, opener) {
  const start = source.indexOf(opener);
  if (start < 0) return '';
  const open = source.indexOf('{', start + opener.length - 1);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    if (source[i] === '}') depth--;
    if (depth === 0) return source.slice(open + 1, i);
  }
  return '';
}

const site = block(config, '\n{$SITE_HOST} {');
const admin = block(config, '\n{$ADMIN_HOST} {');
const common = block(config, '(common) {');
const media = block(config, '(media) {');
const blocked = block(config, '(blocked) {');

describe('global options', () => {
  const global = block(config, '{');

  it('orders rate_limit and reads the extra options from the environment', () => {
    expect(global).toMatch(/order rate_limit before basic_?auth/);
    expect(global).toContain('{$CADDY_GLOBAL_OPTIONS}');
    expect(global).not.toContain('trusted_proxies');
  });

  it('filters the default (error) logger like the access log', () => {
    const filter = block(block(config, 'log default {'), 'format filter {');
    expect(filter).toMatch(/request>uri regexp \\\?\.\* ""/);
    expect(filter).toMatch(/request>headers>Referer delete/);
    expect(filter).toMatch(/request>headers>Cookie delete/);
    expect(filter).toMatch(/request>headers>Authorization delete/);
  });

  it('keeps handle_errors so Caddy-made errors carry HSTS and no Server', () => {
    const errors = block(common, 'handle_errors {');
    expect(errors).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(errors).toMatch(/^\s*-Server\s*$/m);
    // The handled error stays visible on the access line, its query cut off.
    expect(errors).toContain('log_append error_message {err.message}');
    expect(block(common, 'format filter {')).toMatch(/error_message regexp \\\?\\S\* ""/);
  });
});

describe('site blocks', () => {
  it('both exist', () => {
    expect(site).not.toBe('');
    expect(admin).not.toBe('');
  });

  it('both import common, blocked and media', () => {
    for (const body of [site, admin]) {
      expect(body).toMatch(/^\s*import common\s*$/m);
      expect(body).toMatch(/^\s*import blocked\s*$/m);
      expect(body).toMatch(/^\s*import media\s*$/m);
    }
  });

  it('the admin imports admin_headers, the site imports webhook_limits', () => {
    expect(admin).toMatch(/^\s*import admin_headers\s*$/m);
    expect(site).toMatch(/^\s*import webhook_limits\s*$/m);
    expect(admin).not.toContain('webhook_limits');
    expect(site).not.toContain('admin_headers');
  });

  it('the site proxies /api to api:3000 and the rest to web:4000', () => {
    expect(site).toMatch(/handle \/api\/\* \{\s*reverse_proxy api:3000\s*\}/);
    expect(site).toMatch(/reverse_proxy web:4000/);
  });

  it('the admin proxies /api to api:3000, refuses the webhooks and serves /srv/admin', () => {
    expect(admin).toMatch(/handle \/api\/\* \{\s*reverse_proxy api:3000\s*\}/);
    expect(admin).toMatch(/path \/api\/payments\/webhook \/api\/marketing\/webhook/);
    expect(admin).toContain('root * /srv/admin');
    expect(admin).toContain('try_files {path} /index.html');
    expect(admin).toContain('file_server');
    expect(admin).not.toContain('web:4000');
  });

  it('the admin caches hashed files for a year and everything else no-cache', () => {
    expect(admin).toContain('static-media/');
    expect(admin).toMatch(/Cache-Control "public, max-age=31536000, immutable"/);
    expect(admin).toMatch(/Cache-Control no-cache/);
  });
});

describe('(common)', () => {
  it('compresses, sends HSTS without includeSubDomains / preload and drops Server', () => {
    expect(common).toMatch(/encode zstd gzip/);
    expect(common).toContain('Strict-Transport-Security "max-age=31536000"');
    expect(common).not.toMatch(/includeSubDomains|preload/);
    expect(common).toMatch(/^\s*-Server\s*$/m);
  });

  it('logs to stdout without the query, Referer, Cookie or Authorization', () => {
    const log = block(common, 'log {');
    expect(log).toMatch(/output stdout/);
    const filter = block(log, 'format filter {');
    expect(filter).toMatch(/request>uri regexp \\\?\.\* ""/);
    expect(filter).toMatch(/request>headers>Referer delete/);
    expect(filter).toMatch(/request>headers>Cookie delete/);
    expect(filter).toMatch(/request>headers>Authorization delete/);
  });
});

describe('(blocked)', () => {
  it('answers 404 for the internal and dev API routes', () => {
    expect(blocked).toMatch(/path [^\n]*\/api\/internal\/\*/);
    expect(blocked).toMatch(/path [^\n]*\/api\/admin\/dev\/\*/);
    expect(blocked).toMatch(/respond 404/);
  });
});

describe('(media)', () => {
  it('proxies only the public bucket on the public upstream', () => {
    expect(media).toContain('handle /media/* {');
    expect(media).toContain('rewrite * /{$S3_PUBLIC_BUCKET}{path}?');
    expect(media).toContain('reverse_proxy {$S3_PUBLIC_UPSTREAM}');
    expect(config).not.toMatch(/PRIVATE/i);
    expect(config.match(/S3_PUBLIC_BUCKET/g)).toHaveLength(1);
  });

  it('refuses unsafe paths and any method but GET / HEAD before proxying', () => {
    const route = block(media, 'route {');
    const unsafe = route.indexOf('respond @media_unsafe 404');
    const method = route.indexOf('respond @media_method 405');
    const proxy = route.indexOf('reverse_proxy');
    expect(unsafe).toBeGreaterThan(-1);
    expect(method).toBeGreaterThan(-1);
    expect(unsafe).toBeLessThan(proxy);
    expect(method).toBeLessThan(proxy);
    expect(route).toMatch(/not method GET HEAD/);
    // Whitelisted characters only (so no %2f, %2e, %3f, backslash), no "..", no "//".
    expect(route).toContain('[A-Za-z0-9_-][A-Za-z0-9._/-]*');
    expect(route).toContain('contains("..")');
    expect(route).toContain('contains("//")');
  });

  it('never forwards client credentials and sets the upstream Host', () => {
    const proxy = block(media, 'reverse_proxy {$S3_PUBLIC_UPSTREAM} {');
    expect(proxy).toMatch(/header_up Host \{upstream_hostport\}/);
    expect(proxy).toMatch(/header_up -Authorization/);
    expect(proxy).toMatch(/header_up -Cookie/);
    expect(proxy).toMatch(/header_down -X-Amz-\*/i);
  });

  it('marks found photos immutable and nosniff', () => {
    expect(media).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(media).toMatch(/X-Content-Type-Options nosniff/);
  });
});
