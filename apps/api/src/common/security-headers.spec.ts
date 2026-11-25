import type { NextFunction, Request, Response } from 'express';
import { apiSecurityHeaders } from './security-headers.js';

describe('apiSecurityHeaders', () => {
  it('sets the four headers and continues', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (k: string, v: string) => (headers[k] = v) } as unknown as Response;
    const next = vi.fn() as unknown as NextFunction;
    apiSecurityHeaders({} as Request, res, next);
    expect(headers).toEqual({
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'X-Frame-Options': 'DENY',
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
