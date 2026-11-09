import { createHash, randomBytes } from 'node:crypto';

/** The cart cookie (spec §3.1): random token, httpOnly, SameSite=Lax, 30 days, renewed on use. */
export const CART_COOKIE = 'hg_cart';
/** Carts unused this long are deleted, and the cookie lives as long. */
export const CART_TTL_MS = 30 * 24 * 60 * 60_000;

/** 32 random bytes, base64url. */
export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

/** Only this SHA-256 (hex) is stored, never the token itself. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
