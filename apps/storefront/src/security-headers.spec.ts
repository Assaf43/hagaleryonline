import type { Request, Response } from 'express';
import { securityHeaders } from './security-headers';

describe('securityHeaders', () => {
  it('sets Referrer-Policy: same-origin and continues', () => {
    const headers: Record<string, string> = {};
    const res = { setHeader: (name: string, value: string) => (headers[name] = value) } as unknown as Response;
    const next = vi.fn();
    securityHeaders({} as Request, res, next);
    expect(headers['Referrer-Policy']).toBe('same-origin');
    expect(next).toHaveBeenCalledOnce();
  });
});
