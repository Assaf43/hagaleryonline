import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** A random URL-safe token for cookies and one-time links (256 bits). */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

/** What we store for a token: its SHA-256, so a database leak does not reveal live sessions or links. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * AES-256-GCM for secrets we must read back (TOTP secrets). The key comes from TOTP_ENCRYPTION_KEY
 * (32 bytes, base64) so a database dump alone cannot generate 2FA codes.
 * Format: base64url(iv).base64url(tag).base64url(ciphertext)
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(base64Key: string) {
    this.key = Buffer.from(base64Key, 'base64');
    if (this.key.length !== 32) throw new Error('TOTP_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64url')).join('.');
  }

  decrypt(sealed: string): string {
    const [iv, tag, data] = sealed.split('.').map((part) => Buffer.from(part, 'base64url'));
    if (!iv || !tag || !data) throw new Error('Malformed secret');
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  }
}
