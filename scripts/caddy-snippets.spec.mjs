import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'caddy');
const read = (name) => readFileSync(join(dir, name), 'utf8');

// Body of the first `<opener> { ... }` block, brace-aware.
function block(text, opener) {
  const start = text.indexOf(opener);
  if (start < 0) return '';
  const open = text.indexOf('{', start + opener.length - 1);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}') depth--;
    if (depth === 0) return text.slice(open + 1, i);
  }
  return '';
}

describe('block helper', () => {
  it('returns only what is inside the braces, placeholders included', () => {
    const fixture = ['zone z {', ' key {remote_host}', ' events 1', '}', ' window 1m'].join('\n');
    const body = block(fixture, 'zone z {');
    expect(body).toContain('events 1');
    expect(body).not.toContain('window');
  });
});

describe('admin-headers.caddy', () => {
  const text = read('admin-headers.caddy');

  it('defines the admin_headers snippet with every header', () => {
    expect(text).toMatch(/^\(admin_headers\) \{/m);
    expect(text).toContain("Content-Security-Policy \"default-src 'self'; script-src 'self';");
    expect(text).toContain("img-src 'self' data: blob:");
    expect(text).toContain("connect-src 'self'");
    expect(text).toContain("base-uri 'self'");
    expect(text).toContain("object-src 'none'");
    expect(text).toContain("form-action 'self'");
    expect(text).toMatch(/X-Content-Type-Options\s+nosniff/);
    expect(text).toMatch(/X-Frame-Options\s+DENY/);
    expect(text).toMatch(/Referrer-Policy\s+same-origin/);
    expect(text).toContain('Permissions-Policy "camera=(self), microphone=(), geolocation=(), payment=()"');
    expect(text).toContain('X-Robots-Tag "noindex, nofollow"');
    expect(text).toMatch(/^\s*-Server\s*$/m);
  });

  it('keeps every header and -Server inside the header block', () => {
    const body = block(text, 'header {');
    for (const line of [
      'Content-Security-Policy "',
      'X-Content-Type-Options nosniff',
      'X-Frame-Options DENY',
      'Referrer-Policy same-origin',
      'Permissions-Policy "',
      'X-Robots-Tag "noindex, nofollow"',
    ]) {
      expect(body).toContain(line);
    }
    expect(body).toMatch(/^\s*-Server\s*$/m);
  });

  it('forbids framing and never allows eval', () => {
    expect(text).toContain("frame-ancestors 'none'");
    expect(text).not.toContain('unsafe-eval');
  });

  it('leaves HSTS to the site block', () => {
    expect(text).not.toMatch(/Strict-Transport-Security/i);
  });
});

describe('api-limits.caddy', () => {
  const text = read('api-limits.caddy');

  it('defines the webhook_limits snippet', () => {
    expect(text).toMatch(/^\(webhook_limits\) \{/m);
  });

  it('matches both webhook paths and caps the body at 64KB', () => {
    expect(text).toMatch(/@signed_webhooks path \/api\/payments\/webhook \/api\/marketing\/webhook/);
    expect(text).toMatch(/request_body @signed_webhooks \{\s*max_size 64KB\s*\}/);
  });

  it('keeps key, events and window inside the zone block', () => {
    const body = block(text, 'zone webhooks {');
    expect(body).toMatch(/key\s+\{client_ip\}/);
    expect(body).toMatch(/events\s+120/);
    expect(body).toMatch(/window\s+1m/);
  });

  it('rate limits per client IP (CF-Connecting-IP from a trusted range), 120 events a minute', () => {
    expect(text).toContain('rate_limit @signed_webhooks');
    expect(text).toMatch(/key\s+\{client_ip\}/);
    expect(text).not.toContain('{remote_host}');
    expect(text).toMatch(/events\s+120/);
    expect(text).toMatch(/window\s+1m/);
  });
});

// Plain directives (no snippet wrapper), imported inside the site blocks; comments never count.
const directives = (name) =>
  read(name)
    .split('\n')
    .filter((line) => line.trim() && !line.trim().startsWith('#'))
    .join('\n');

describe('env-*.caddy', () => {
  it('production adds nothing', () => {
    expect(directives('env-production.caddy')).toBe('');
  });

  it('rehearsal: noindex, no gate', () => {
    expect(directives('env-rehearsal.caddy')).toBe('header X-Robots-Tag "noindex, nofollow"');
  });

  it('staging: noindex, the login gate except /api/health and /robots.txt, the password not forwarded', () => {
    const text = directives('env-staging.caddy');
    expect(text).toMatch(/^header X-Robots-Tag "noindex, nofollow"$/m);
    // On the raw request URI, so an encoded path that cleans to an exempt one stays gated.
    expect(text).toContain(
      '@gated not expression `{http.request.orig_uri}.matches("^/(api/health|robots\\\\.txt)(\\\\?.*)?$")`',
    );
    expect(text).not.toMatch(/@gated not path/);
    // Quoted, so an empty user or hash is an empty token and Caddy refuses to start.
    expect(block(text, 'basic_auth @gated {').trim()).toBe('"{$STAGING_AUTH_USER}" "{$STAGING_AUTH_HASH}"');
    expect(text).toMatch(/^request_header @gated -Authorization$/m);
    expect(text).not.toMatch(/\$2[aby]\$/);
  });
});

describe('tls-*.caddy', () => {
  it('origin uses the mounted Cloudflare Origin CA certificate, auto adds nothing', () => {
    expect(directives('tls-origin.caddy')).toBe('tls /etc/caddy/origin/cert.pem /etc/caddy/origin/key.pem');
    expect(directives('tls-auto.caddy')).toBe('');
  });
});

describe('cloudflare-ips.txt', () => {
  const text = readFileSync(join(dir, '..', 'cloudflare-ips.txt'), 'utf8');
  const ranges = text.split('\n').filter((line) => line.trim() && !line.startsWith('#'));

  it('has a dated header and one CIDR per line, IPv4 and IPv6, never a catch-all', () => {
    expect(text).toMatch(
      /^# .*fetched \d{4}-\d{2}-\d{2} from https:\/\/www\.cloudflare\.com\/ips-v4 and https:\/\/www\.cloudflare\.com\/ips-v6/,
    );
    expect(text).not.toContain('\r');
    for (const range of ranges) expect(range).toMatch(/^(\d{1,3}(\.\d{1,3}){3}\/\d{1,2}|[0-9a-f:]+::\/\d{1,3})$/);
    expect(ranges.filter((r) => r.includes('.')).length).toBeGreaterThan(5);
    expect(ranges.filter((r) => r.includes(':')).length).toBeGreaterThan(3);
    expect(new Set(ranges).size).toBe(ranges.length);
    expect(ranges).not.toContain('0.0.0.0/0');
    expect(ranges).not.toContain('::/0');
  });
});

describe('README.md', () => {
  const text = read('README.md');

  it('documents the plugin, the directive order and the 9b checks', () => {
    expect(text).toContain('caddy-ratelimit');
    expect(text).toContain('order rate_limit before basicauth');
    expect(text).toContain('curl -sI');
  });
});
