import { randomBytes } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { buildStorefrontCsp } from './csp';
import type { CspMode } from './server-env';

const PERMISSIONS = 'microphone=(), geolocation=(), payment=(), usb=()';

/**
 * Headers every SSR response carries (NFR-07). Each request gets a fresh nonce in `res.locals.cspNonce`; server.ts
 * hands it to the Angular render (CSP_NONCE). `Referrer-Policy: same-origin` keeps the order token in /order/{n}?t=
 * (and the sandbox transaction in /pay/...) from leaking to other sites through the Referer header. The camera is
 * allowed only on the damaged-product report, where the photo picker may use it. HSTS comes with Caddy.
 */
export function securityHeaders(mode: CspMode) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const nonce = randomBytes(16).toString('base64');
    res.locals['cspNonce'] = nonce;
    if (mode !== 'off') {
      const name = mode === 'enforce' ? 'Content-Security-Policy' : 'Content-Security-Policy-Report-Only';
      res.setHeader(name, buildStorefrontCsp(nonce));
    }
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    const camera = req.path === '/returns/damaged' ? 'camera=(self)' : 'camera=()';
    res.setHeader('Permissions-Policy', `${camera}, ${PERMISSIONS}`);
    next();
  };
}
