import type { NextFunction, Request, Response } from 'express';

/**
 * Headers every SSR response carries. `Referrer-Policy: same-origin` keeps the order token in /order/{n}?t= (and
 * the sandbox transaction in /pay/...) from leaking to other sites through the Referer header. CSP, HSTS and the
 * rest come with Phase 9 (Caddy).
 */
export function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
}
