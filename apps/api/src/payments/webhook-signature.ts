import { createHmac, timingSafeEqual } from 'node:crypto';

/** Header that carries the sandbox webhook signature. */
export const SANDBOX_SIGNATURE_HEADER = 'x-sandbox-signature';

const HEX_SHA256 = /^[0-9a-f]{64}$/i;

/** Hex HMAC-SHA256 of the exact body bytes (spec §5.3). */
export function sign(body: string | Buffer, secret: string): string {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Whether `signature` is the HMAC of `body` with `secret`. The comparison is constant-time over the 32 digest bytes;
 * anything that is not 64 hex characters is refused before comparing, and an empty secret never verifies.
 */
export function verify(body: string | Buffer, signature: unknown, secret: string): boolean {
  if (!secret || typeof signature !== 'string' || !HEX_SHA256.test(signature)) return false;
  const expected = Buffer.from(sign(body, secret), 'hex');
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
