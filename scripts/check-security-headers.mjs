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

const TAG = /<([a-z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/gi;
const ATTR = /([^\s"'=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

/** The real attributes of one tag: names are lower-cased, text inside a quoted value is never an attribute. */
function parseAttrs(source) {
  return [...source.matchAll(ATTR)].map((m) => ({ name: m[1].toLowerCase(), value: m[2] ?? m[3] ?? m[4] }));
}
const attrValue = (attrs, name) => attrs.find((a) => a.name === name)?.value;

export function checkResponse(headers, html, kind, options = {}) {
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
  if (options.requireEnforce && cspName !== 'content-security-policy') {
    problems.push('CSP is report-only, enforcement required');
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
    for (const m of page.matchAll(TAG)) {
      if (m[1].toLowerCase() !== tag) continue;
      const attrs = parseAttrs(m[2]);
      if (tag === 'script') {
        if (attrs.some((a) => a.name === 'src')) continue;
        if (DATA_SCRIPT_TYPES.has((attrValue(attrs, 'type') ?? '').toLowerCase())) continue;
      }
      const nonce = attrValue(attrs, 'nonce');
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
  for (const m of markup.matchAll(TAG)) {
    for (const a of parseAttrs(m[2])) if (/^on[a-z]+$/.test(a.name)) handlers.add(`${a.name}=`);
  }
  for (const h of handlers) problems.push(`inline event-handler attribute ${h}`);
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const kindFlag = args.find((a) => a.startsWith('--kind='));
  const requireEnforce = args.includes('--require-enforce');
  const [base, ...paths] = args.filter((a) => !a.startsWith('--'));
  if (!base || paths.length === 0) {
    console.error('usage: check-security-headers.mjs [--kind=storefront|api] [--require-enforce] <base-url> <path…>');
    process.exit(2);
  }
  const kind = kindFlag ? kindFlag.slice(7) : paths.every((p) => p.startsWith('/api')) ? 'api' : 'storefront';
  if (kind !== 'storefront' && kind !== 'api') {
    console.error(`unknown --kind=${kind}; use storefront or api`);
    process.exit(2);
  }
  let failed = 0;
  for (const path of paths) {
    let line;
    try {
      const res = await fetch(new URL(path, base), { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
      const body = await res.text();
      const problems = checkResponse(res.headers, body, kind, { requireEnforce });
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
