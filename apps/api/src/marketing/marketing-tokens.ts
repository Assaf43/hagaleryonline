import { createHmac } from 'node:crypto';
import { hashToken, randomToken } from '../auth/crypto.js';

/** A confirmation link works for 7 days from the message that carries it (spec §4.4). */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60_000;

/** A new random confirmation token: the raw value goes only into the message link, the hash into the contact row. */
export function newConfirmToken(): { token: string; hash: string } {
  const token = randomToken();
  return { token, hash: hashToken(token) };
}

/** Only for development and tests: production refuses to start without its own `MARKETING_TOKEN_SECRET`. */
const DEV_TOKEN_SECRET = 'dev-marketing-token-secret-not-for-production';
const MIN_SECRET_LENGTH = 32;

/**
 * The HMAC key of the unsubscribe tokens: `MARKETING_TOKEN_SECRET`, required in production (at least 32 characters).
 * Its own secret, not `OTP_PEPPER`: rotating the code pepper must not kill the unsubscribe links already sent.
 */
export function resolveMarketingTokenSecret(value: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'production') return value || DEV_TOKEN_SECRET;
  if (!value || value.length < MIN_SECRET_LENGTH)
    throw new Error('MARKETING_TOKEN_SECRET is required in production (at least 32 random characters).');
  return value;
}

/**
 * The unsubscribe token of a contact is stable: an HMAC of its id under `MARKETING_TOKEN_SECRET`, so every message we
 * send carries a link that keeps working (also after a later message), yet the raw token is stored nowhere — the
 * contact row keeps only its SHA-256 (`unsubscribeTokenHash`, used to find the contact). Changing the secret retires
 * the links already sent; the next message to the contact writes the new hash.
 */
export class UnsubscribeTokens {
  constructor(private readonly secret: string) {}

  token(contactId: string): string {
    return createHmac('sha256', this.secret).update(`marketing-unsubscribe:${contactId}`).digest('base64url');
  }

  hash(contactId: string): string {
    return hashToken(this.token(contactId));
  }
}

/** The storefront pages of the links (Task 5 builds them): `/newsletter/confirm?t=` and `/newsletter/unsubscribe?t=`. */
export const confirmLink = (site: string, token: string) => `${site}/newsletter/confirm?t=${encodeURIComponent(token)}`;
export const unsubscribeLink = (site: string, token: string) =>
  `${site}/newsletter/unsubscribe?t=${encodeURIComponent(token)}`;
