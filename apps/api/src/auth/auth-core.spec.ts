import { randomBytes } from 'node:crypto';
import { TOTP, Secret } from 'otpauth';
import { effectivePermissions } from '@hg/models';
import { SecretBox, hashToken, randomToken } from './crypto.js';
import { IpThrottle, accountDelayMs } from './login-throttle.js';
import { checkPassword, hashPassword, verifyPassword } from './passwords.js';
import { newRecoveryCodes, newTotpSecret, verifyTotp } from './totp.js';

describe('tokens and secrets', () => {
  it('stores only a hash of a token', () => {
    const token = randomToken();
    expect(token).toHaveLength(43);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  it('round-trips a secret and rejects tampering or a wrong key', () => {
    const box = new SecretBox(randomBytes(32).toString('base64'));
    const sealed = box.encrypt('JBSWY3DPEHPK3PXP');
    expect(box.decrypt(sealed)).toBe('JBSWY3DPEHPK3PXP');
    const [iv, tag, data] = sealed.split('.');
    expect(() => box.decrypt([iv, tag, data.slice(0, -2) + 'AA'].join('.'))).toThrow();
    expect(() => new SecretBox(randomBytes(32).toString('base64')).decrypt(sealed)).toThrow();
    expect(() => new SecretBox('short')).toThrow();
  });
});

describe('password policy (decision 59)', () => {
  it('requires at least 12 characters', () => {
    expect(checkPassword('Ab1!Ab1!Ab1')).toBe('too_short');
  });

  it('rejects common and guessable passwords even when long', () => {
    expect(checkPassword('123456789012')).toBe('too_common');
    expect(checkPassword('passwordpassword')).toBe('too_common');
    expect(checkPassword('qwertyuiopasdf')).toBe('too_common');
  });

  it('rejects passwords built from the user’s own e-mail or name', () => {
    expect(checkPassword('moshe.levi2026', ['moshe.levi@example.com', 'Moshe Levi'])).toBe('too_personal');
    expect(checkPassword('olive sofa sunset window', ['olive@example.com'])).toBe('too_personal');
  });

  it('accepts a long passphrase without special characters', () => {
    expect(checkPassword('olive sofa sunset window')).toBeNull();
  });

  it('hashes with argon2id and verifies', async () => {
    const stored = await hashPassword('olive sofa sunset window');
    expect(stored).toMatch(/^\$argon2id\$/);
    expect(await verifyPassword(stored, 'olive sofa sunset window')).toBe(true);
    expect(await verifyPassword(stored, 'olive sofa sunset windoW')).toBe(false);
    expect(await verifyPassword('not-a-hash', 'x')).toBe(false);
  });
});

describe('TOTP and recovery codes (decision 51)', () => {
  it('accepts the current code and one step of drift, nothing older', () => {
    const secret = newTotpSecret();
    const totp = new TOTP({ secret: Secret.fromBase32(secret) });
    const now = Date.now();
    expect(verifyTotp(secret, totp.generate({ timestamp: now }), now)).toBe(true);
    expect(verifyTotp(secret, totp.generate({ timestamp: now - 30_000 }), now)).toBe(true);
    expect(verifyTotp(secret, totp.generate({ timestamp: now - 120_000 }), now)).toBe(false);
    expect(verifyTotp(secret, 'abc123', now)).toBe(false);
  });

  it('creates 10 distinct readable recovery codes', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((c) => /^[a-z2-9]{4}-[a-z2-9]{4}$/.test(c))).toBe(true);
  });
});

describe('brute-force protection', () => {
  it('waits progressively after 5 failures, capped at 15 minutes', () => {
    expect(accountDelayMs(4)).toBe(0);
    expect(accountDelayMs(5)).toBe(30_000);
    expect(accountDelayMs(6)).toBe(60_000);
    expect(accountDelayMs(50)).toBe(15 * 60_000);
  });

  it('limits attempts per IP within the window', () => {
    let now = 0;
    const throttle = new IpThrottle(3, 1_000, () => now);
    expect([1, 2, 3, 4].map(() => throttle.allow('1.1.1.1'))).toEqual([true, true, true, false]);
    expect(throttle.allow('2.2.2.2')).toBe(true);
    now = 1_000;
    expect(throttle.allow('1.1.1.1')).toBe(true);
  });
});

describe('effective permissions (decision 49)', () => {
  const base = { isSuperAdmin: false, extraPermissions: [], removedPermissions: [] };

  it('uses the template, plus added, minus removed', () => {
    expect(effectivePermissions({ ...base, template: 'store_seller' })).toEqual(['orders.view']);
    expect(
      effectivePermissions({
        ...base,
        template: 'content_editor',
        extraPermissions: ['audit.view'],
        removedPermissions: ['catalog.import'],
      }),
    ).toEqual(['catalog.view', 'catalog.edit', 'media.manage', 'content.manage', 'audit.view']);
  });

  it('gives the Super Admin everything and an unknown template nothing', () => {
    expect(effectivePermissions({ ...base, isSuperAdmin: true, template: null })).toContain('audit.view');
    expect(effectivePermissions({ ...base, template: 'pirate' })).toEqual([]);
  });
});
