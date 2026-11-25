import { createHmac, timingSafeEqual } from 'node:crypto';
import { LANDING_PREVIEW_TTL_MS } from '@hg/models';

/**
 * Staff preview of a landing page (Phase 8 §4.7, §9 "Preview token"): the admin and the storefront are different
 * origins, so a cookie cannot carry the staff session; the admin asks the API for a signed token instead and opens
 * `/collection/<slug>?preview=<token>`. The token is `<pageId>.<expiry ms>.<HMAC-SHA256>`, bound to one page and valid
 * 30 minutes; the HMAC is compared in constant time. Nothing is stored: a token cannot be withdrawn, it just expires.
 */

/** Only for development and tests: production refuses to start without its own `CONTENT_PREVIEW_SECRET`. */
export const DEV_PREVIEW_SECRET = 'dev-content-preview-secret-not-for-production';
const MIN_SECRET_LENGTH = 32;
/** Longer input is refused before any work (a real token is about 70 characters). */
const MAX_TOKEN_LENGTH = 200;
const TOKEN = /^([1-9][0-9]{0,9})\.([1-9][0-9]{0,15})\.([A-Za-z0-9_-]{43})$/;

/** `CONTENT_PREVIEW_SECRET`: required in production (at least 32 characters); dev and tests fall back to a fixed one. */
export function resolvePreviewSecret(value: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'production') return value || DEV_PREVIEW_SECRET;
  if (!value || value.length < MIN_SECRET_LENGTH)
    throw new Error('CONTENT_PREVIEW_SECRET is required in production (at least 32 random characters).');
  return value;
}

const mac = (secret: string, pageId: number, expires: number) =>
  createHmac('sha256', secret).update(`landing-preview:${pageId}:${expires}`).digest('base64url');

/** A token for `pageId` that expires 30 minutes after `now`. */
export function signPreview(pageId: number, now: Date, secret: string): string {
  const expires = now.getTime() + LANDING_PREVIEW_TTL_MS;
  return `${pageId}.${expires}.${mac(secret, pageId, expires)}`;
}

/** When a token made at `now` expires. */
export const previewExpiry = (now: Date) => new Date(now.getTime() + LANDING_PREVIEW_TTL_MS);

/**
 * True only for an untampered token of exactly this page that has not expired at `now` (the expiry instant itself is
 * already expired). A token of another page, an altered expiry or signature, or one made with another secret fails.
 */
export function verifyPreview(token: string, pageId: number, now: Date, secret: string): boolean {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return false;
  const match = TOKEN.exec(token);
  if (!match) return false;
  const [, id, exp, signature] = match;
  if (Number(id) !== pageId) return false;
  const expires = Number(exp);
  if (!Number.isSafeInteger(expires) || now.getTime() >= expires) return false;
  const expected = Buffer.from(mac(secret, pageId, expires));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** The preview signer with its secret, provided once by the module (the secret is read at startup). */
export class PreviewTokens {
  constructor(private readonly secret: string) {}

  sign(pageId: number, now: Date): string {
    return signPreview(pageId, now, this.secret);
  }

  verify(token: string, pageId: number, now: Date): boolean {
    return verifyPreview(token, pageId, now, this.secret);
  }

  /**
   * The page a valid token opens, or null: checked before any database read, so a junk `?preview=` costs no query.
   */
  pageOf(token: string, now: Date): number | null {
    const id = typeof token === 'string' ? TOKEN.exec(token)?.[1] : undefined;
    return id !== undefined && verifyPreview(token, Number(id), now, this.secret) ? Number(id) : null;
  }
}
