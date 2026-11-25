import { describe, expect, it } from 'vitest';
import { checkResponse } from './check-security-headers.mjs';

const csp = (n = 'abc') =>
  `default-src 'self'; script-src 'self' 'nonce-${n}'; style-src 'self' 'nonce-${n}'; frame-ancestors 'none'`;
const good = () => ({
  'Content-Security-Policy': csp(),
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'same-origin',
  'Permissions-Policy': 'camera=()',
});
const page = (body) => `<html><body>${body}</body></html>`;

describe('checkResponse storefront', () => {
  it('accepts a correct page', () => {
    const html = page('<script nonce="abc">x()</script><style nonce="abc">a{}</style><a href="/">x</a>');
    expect(checkResponse(good(), html, 'storefront')).toEqual([]);
  });
  it('accepts a report-only policy', () => {
    const h = good();
    h['Content-Security-Policy-Report-Only'] = h['Content-Security-Policy'];
    delete h['Content-Security-Policy'];
    expect(checkResponse(h, page(''), 'storefront')).toEqual([]);
  });
  it('reports a missing header', () => {
    const h = good();
    delete h['X-Frame-Options'];
    expect(checkResponse(h, page(''), 'storefront')).toEqual(['missing header x-frame-options']);
  });
  it('reports a missing CSP', () => {
    const h = good();
    delete h['Content-Security-Policy'];
    expect(checkResponse(h, page(''), 'storefront')).toContain('missing header content-security-policy');
  });
  it('reports a nonce mismatch on a script and a style', () => {
    const html = page('<script nonce="zzz">x()</script><style nonce="zzz"></style>');
    const problems = checkResponse(good(), html, 'storefront');
    expect(problems).toContain('inline script nonce does not match the CSP');
    expect(problems).toContain('inline style nonce does not match the CSP');
  });
  it('reports an inline script or style without a nonce', () => {
    const problems = checkResponse(good(), page('<script>x()</script><style>a{}</style>'), 'storefront');
    expect(problems).toContain('inline script without a nonce');
    expect(problems).toContain('inline style without a nonce');
  });
  it('exempts JSON and JSON-LD data scripts and external scripts', () => {
    const html = page(
      '<script type="application/json" id="ng-state">{}</script><script type="application/ld+json">{}</script><script src="/a.js"></script>',
    );
    expect(checkResponse(good(), html, 'storefront')).toEqual([]);
  });
  it('reports on* attributes but not the text inside a script', () => {
    const bad = checkResponse(good(), page('<link rel="stylesheet" media="print" onload="go()">'), 'storefront');
    expect(bad).toEqual(['inline event-handler attribute onload=']);
    const ok = page('<script nonce="abc">var s = "<b onclick=1>"</script>');
    expect(checkResponse(good(), ok, 'storefront')).toEqual([]);
  });
  it('requires a nonce in the CSP', () => {
    const h = good();
    h['Content-Security-Policy'] = "default-src 'self'; frame-ancestors 'none'";
    const problems = checkResponse(h, page(''), 'storefront');
    expect(problems).toContain('CSP script-src has no nonce');
  });
});

describe('checkResponse api', () => {
  const api = () => ({
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
  });
  it('accepts the API headers', () => {
    expect(checkResponse(api(), '{}', 'api')).toEqual([]);
  });
  it('rejects the wrong referrer policy and a missing CSP', () => {
    const h = api();
    h['Referrer-Policy'] = 'same-origin';
    delete h['Content-Security-Policy'];
    const problems = checkResponse(h, '{}', 'api');
    expect(problems).toContain('missing header content-security-policy');
    expect(problems.some((p) => p.startsWith('header referrer-policy'))).toBe(true);
  });
  it('accepts a fetch Headers object', () => {
    expect(checkResponse(new Headers(api()), '{}', 'api')).toEqual([]);
  });
});
