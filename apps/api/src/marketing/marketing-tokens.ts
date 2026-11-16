import { createHmac } from 'node:crypto';
import { hashToken, randomToken } from '../auth/crypto.js';

/** A confirmation link works for 7 days from the message that carries it (spec §4.4). */
export const CONFIRM_TTL_MS = 7 * 24 * 60 * 60_000;

/** A new random confirmation token: the raw value goes only into the message link, the hash into the contact row. */
export function newConfirmToken(): { token: string; hash: string } {
  const token = randomToken();
  return { token, hash: hashToken(token) };
}

/**
 * The unsubscribe token of a contact is stable: an HMAC of its id under a server secret, so every message we send
 * carries a link that keeps working (also after a later message), yet the raw token is stored nowhere — the contact row
 * keeps only its SHA-256 (`unsubscribeTokenHash`, used to find the contact). Changing the secret retires the links
 * already sent; the next message to the contact writes the new hash.
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
