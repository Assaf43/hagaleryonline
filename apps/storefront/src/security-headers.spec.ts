import type { Request, Response } from 'express';
import type { CspMode } from './server-env';
import { securityHeaders } from './security-headers';

function run(mode: CspMode, path = '/') {
  const headers: Record<string, string> = {};
  const res = {
    locals: {} as Record<string, unknown>,
    setHeader: (name: string, value: string) => (headers[name] = value),
  } as unknown as Response;
  const next = vi.fn();
  securityHeaders(mode)({ path } as Request, res, next);
  expect(next).toHaveBeenCalledOnce();
  return { headers, nonce: res.locals['cspNonce'] as string };
}

describe('securityHeaders', () => {
  it('sets Referrer-Policy, nosniff, X-Frame-Options and Permissions-Policy in every mode', () => {
    for (const mode of ['enforce', 'report-only', 'off'] as const) {
      const { headers } = run(mode);
      expect(headers['Referrer-Policy']).toBe('same-origin');
      expect(headers['X-Content-Type-Options']).toBe('nosniff');
      expect(headers['X-Frame-Options']).toBe('DENY');
      expect(headers['Permissions-Policy']).toBe('camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    }
  });

  it('allows the camera only on /returns/damaged', () => {
    expect(run('enforce', '/returns/damaged').headers['Permissions-Policy']).toBe(
      'camera=(self), microphone=(), geolocation=(), payment=(), usb=()',
    );
    for (const path of ['/returns', '/returns/damaged/x', '/contact'])
      expect(run('enforce', path).headers['Permissions-Policy']).toContain('camera=()');
  });

  it('enforces the CSP with the request nonce', () => {
    const { headers, nonce } = run('enforce');
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(headers['Content-Security-Policy']).toContain(`script-src 'self' 'nonce-${nonce}'`);
    expect(headers['Content-Security-Policy-Report-Only']).toBeUndefined();
  });

  it('sends the policy as report-only', () => {
    const { headers, nonce } = run('report-only');
    expect(headers['Content-Security-Policy-Report-Only']).toContain(`style-src 'self' 'nonce-${nonce}'`);
    expect(headers['Content-Security-Policy']).toBeUndefined();
  });

  it('sends no policy when off, but still makes a nonce', () => {
    const { headers, nonce } = run('off');
    expect(headers['Content-Security-Policy']).toBeUndefined();
    expect(headers['Content-Security-Policy-Report-Only']).toBeUndefined();
    expect(nonce).toBeTruthy();
  });

  it('makes a new nonce for every request', () => {
    const nonces = new Set(Array.from({ length: 20 }, () => run('enforce').nonce));
    expect(nonces.size).toBe(20);
  });
});
