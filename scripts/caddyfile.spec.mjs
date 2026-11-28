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
  });

  it('trusts only CF_TRUSTED_RANGES and takes the client IP from CF-Connecting-IP (decision 106)', () => {
    const servers = block(global, 'servers {');
    expect(servers).toMatch(/^\s*trusted_proxies static \{\$CF_TRUSTED_RANGES\}\s*$/m);
    expect(servers).toMatch(/^\s*client_ip_headers CF-Connecting-IP\s*$/m);
    expect(servers).toMatch(/^\s*trusted_proxies_strict\s*$/m);
    expect(config.match(/trusted_proxies /g)).toHaveLength(1);
  });

  it('imports the two snippet files by name, never env-* / tls-* at the top level', () => {
    const top = config.replace(/\n\{\$(SITE|ADMIN)_HOST\} \{[\s\S]*$/, '');
    expect(top).toMatch(/^import admin-headers\.caddy$/m);
    expect(top).toMatch(/^import api-limits\.caddy$/m);
    expect(top).not.toMatch(/^import \*/m);
    expect(top).not.toMatch(/import (env|tls)-/);
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
    expect(errors).toContain('Strict-Transport-Security "max-age=31536000; includeSubDomains"');
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

  it('both import the environment and TLS switch files', () => {
    for (const body of [site, admin]) {
      expect(body).toMatch(/^\s*import env-\{\$CADDY_ENV\}\.caddy\s*$/m);
      expect(body).toMatch(/^\s*import tls-\{\$CADDY_TLS\}\.caddy\s*$/m);
    }
  });

  it('every app proxy sends the client IP as X-Forwarded-For, the request host as X-Forwarded-Host, and drops CF-Connecting-IP', () => {
    const proxies = [...config.matchAll(/reverse_proxy (api:3000|web:4000) \{/g)];
    expect(proxies.map((m) => m[1]).sort()).toEqual(['api:3000', 'api:3000', 'web:4000']);
    expect(config).not.toMatch(/reverse_proxy (api:3000|web:4000)\s*\n/);
    for (const m of proxies) {
      const body = block(config.slice(m.index), `reverse_proxy ${m[1]} {`);
      expect(body).toMatch(/^\s*header_up X-Forwarded-For \{client_ip\}\s*$/m);
      expect(body).toMatch(/^\s*header_up X-Forwarded-Host \{host\}\s*$/m);
      expect(body).toMatch(/^\s*header_up -CF-Connecting-IP\s*$/m);
    }
  });

  it('body limits: site 55MB for damaged photos and 1MB elsewhere (never nested, raw URI), admin 16MB', () => {
    const raw = '{http.request.orig_uri}.matches("^/api/support/damaged(\\\\?.*)?$")';
    expect(site).toContain('@damaged expression `' + raw + '`');
    expect(site).toContain('@not_damaged not expression `' + raw + '`');
    expect(site).toMatch(/request_body @damaged \{\s*max_size 55MB\s*\}/);
    expect(site).toMatch(/request_body @not_damaged \{\s*max_size 1MB\s*\}/);
    expect(site.match(/request_body/g)).toHaveLength(2);
    expect(admin).toMatch(/request_body \{\s*max_size 16MB\s*\}/);
    expect(admin.match(/request_body/g)).toHaveLength(1);
  });

  it('the site proxies /api to api:3000 and the rest to web:4000', () => {
    expect(site).toMatch(/handle \/api\/\* \{\s*reverse_proxy api:3000 \{/);
    expect(site).toMatch(/reverse_proxy web:4000/);
  });

  it('the admin proxies /api to api:3000, refuses the webhooks and serves /srv/admin', () => {
    expect(admin).toMatch(/handle \/api\/\* \{\s*reverse_proxy api:3000 \{/);
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
  it('compresses, sends HSTS with includeSubDomains (no preload) and drops Server', () => {
    expect(common).toMatch(/encode zstd gzip/);
    expect(common.match(/Strict-Transport-Security "max-age=31536000; includeSubDomains"/g)).toHaveLength(2);
    expect(common).not.toMatch(/preload/);
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
    expect(proxy).toMatch(/header_up -X-Forwarded-For/);
    expect(proxy).toMatch(/header_up -CF-Connecting-IP/);
    expect(proxy).toMatch(/header_down -X-Amz-\*/i);
  });

  it('marks found photos immutable and nosniff', () => {
    expect(media).toContain('Cache-Control "public, max-age=31536000, immutable"');
    expect(media).toMatch(/X-Content-Type-Options nosniff/);
  });
});
