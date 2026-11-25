#!/usr/bin/env node
/**
 * NFR-07 (Phase 9a): checks the security headers and the CSP nonces of live responses.
 * Usage: node scripts/check-security-headers.mjs [--kind=storefront|api] <base-url> <path…>
 * One line per path (OK or the problems); exit 1 when any path has a problem.
 * `checkResponse(headers, html, kind)` is pure and unit-tested; it returns a list of problem strings.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSP_NAMES = ['content-security-policy', 'content-security-policy-report-only'];
const DATA_SCRIPT_TYPES = new Set(['application/json', 'application/ld+json']);

/** Case-insensitive header lookup over a fetch `Headers` or a plain object. */
function headerReader(headers) {
  if (typeof headers?.get === 'function') return (name) => headers.get(name) ?? undefined;
  const map = new Map(Object.entries(headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  return (name) => map.get(name.toLowerCase());
}

const attr = (attrs, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
};

export function checkResponse(headers, html, kind) {
  const get = headerReader(headers);
  const problems = [];
  const need = (name, ok, expected) => {
    const value = get(name);
    if (value === undefined) problems.push(`missing header ${name}`);
    else if (ok && !ok(value)) problems.push(`header ${name} is "${value}", expected ${expected}`);
  };

  need('x-content-type-options', (v) => v.toLowerCase() === 'nosniff', 'nosniff');
  need('x-frame-options', (v) => v.toUpperCase() === 'DENY', 'DENY');

  if (kind === 'api') {
    need('referrer-policy', (v) => v === 'no-referrer', 'no-referrer');
    need(
      'content-security-policy',
      (v) => /default-src 'none'/.test(v) && /frame-ancestors 'none'/.test(v),
      "default-src 'none' and frame-ancestors 'none'",
    );
    return problems;
  }

  need('referrer-policy', (v) => v === 'same-origin', 'same-origin');
  need('permissions-policy');
  const cspName = CSP_NAMES.find((n) => get(n) !== undefined);
  if (!cspName) {
    problems.push('missing header content-security-policy');
    return problems;
  }
  const csp = get(cspName);
  if (!/frame-ancestors 'none'/.test(csp)) problems.push("CSP lacks frame-ancestors 'none'");
  const nonceOf = (directive) => new RegExp(`(?:^|;)\\s*${directive}\\s[^;]*'nonce-([^']+)'`).exec(csp)?.[1];
  const scriptNonce = nonceOf('script-src');
  const styleNonce = nonceOf('style-src');
  if (!scriptNonce) problems.push('CSP script-src has no nonce');
  if (!styleNonce) problems.push('CSP style-src has no nonce');

  const page = html ?? '';
  const check = (tag, expected, label) => {
    for (const m of page.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'gi'))) {
      const attrs = m[1];
      if (tag === 'script') {
        if (attr(attrs, 'src') !== undefined) continue;
        if (DATA_SCRIPT_TYPES.has((attr(attrs, 'type') ?? '').toLowerCase())) continue;
      }
      const nonce = attr(attrs, 'nonce');
      if (nonce === undefined) problems.push(`inline ${label} without a nonce`);
      else if (expected && nonce !== expected) problems.push(`inline ${label} nonce does not match the CSP`);
    }
  };
  check('script', scriptNonce, 'script');
  check('style', styleNonce, 'style');

  // Event-handler attributes in markup (script / style bodies and comments removed first).
  const markup = page
    .replace(/<script\b[\s\S]*?<\/script>/gi, '<script></script>')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '<style></style>')
    .replace(/<!--[\s\S]*?-->/g, '');
  const handlers = new Set();
  for (const m of markup.matchAll(/<[a-z][^>]*?\son([a-z]+)\s*=/gi)) handlers.add(`on${m[1].toLowerCase()}`);
  for (const h of handlers) problems.push(`inline event-handler attribute ${h}=`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const kindFlag = args.find((a) => a.startsWith('--kind='));
  const [base, ...paths] = args.filter((a) => !a.startsWith('--kind='));
  if (!base || paths.length === 0) {
    console.error('usage: check-security-headers.mjs [--kind=storefront|api] <base-url> <path…>');
    process.exit(2);
  }
  const kind = kindFlag ? kindFlag.slice(7) : paths.every((p) => p.startsWith('/api')) ? 'api' : 'storefront';
  let failed = 0;
  for (const path of paths) {
    let line;
    try {
      const res = await fetch(new URL(path, base), { redirect: 'manual' });
      const body = await res.text();
      const problems = checkResponse(res.headers, body, kind);
      line = problems.length ? `FAIL ${res.status} ${path}: ${problems.join('; ')}` : `OK   ${res.status} ${path}`;
      if (problems.length) failed++;
    } catch (error) {
      line = `FAIL --- ${path}: ${error.message}`;
      failed++;
    }
    console.log(line);
  }
  if (failed) {
    console.error(`check-security-headers: ${failed} of ${paths.length} paths have problems.`);
    process.exit(1);
  }
  console.log(`check-security-headers: ${paths.length} paths OK.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
