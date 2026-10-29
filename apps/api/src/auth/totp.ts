import { Secret, TOTP } from 'otpauth';
import { toDataURL } from 'qrcode';
import { randomInt } from 'node:crypto';

const ISSUER = 'הגלריה לכולם';
/** Accept the previous and next 30-second window, for clock drift. */
const WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

function totpFor(secretBase32: string, label: string): TOTP {
  return new TOTP({
    issuer: ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secretBase32),
  });
}

export function newTotpSecret(): string {
  return new Secret({ size: 20 }).base32;
}

export async function totpSetupFor(secretBase32: string, email: string) {
  const otpauthUrl = totpFor(secretBase32, email).toString();
  return { otpauthUrl, qrDataUrl: await toDataURL(otpauthUrl, { margin: 1, width: 240 }), secret: secretBase32 };
}

export function verifyTotp(secretBase32: string, code: string, timestamp = Date.now()): boolean {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return false;
  return totpFor(secretBase32, 'x').validate({ token: digits, window: WINDOW, timestamp }) !== null;
}

/** Recovery codes like "k7rm-q2xd" — 40 bits each, easy to read aloud and type. */
export function newRecoveryCodes(): string[] {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const part = () => Array.from({ length: 4 }, () => alphabet[randomInt(alphabet.length)]).join('');
  return Array.from({ length: RECOVERY_CODE_COUNT }, () => `${part()}-${part()}`);
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/\s/g, '');
}
