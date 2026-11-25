import type { NextFunction, Request, Response } from 'express';

/**
 * Headers for every answer of the API (NFR-07). It serves JSON and files only, never a page, so nothing may run or
 * embed. Registered first in `configureApp`: it covers 404s, errors and `/media` too. An endpoint that needs another
 * policy sets its own with `@Header` (invoices, support attachments), which replaces these values.
 */
export function apiSecurityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
}
