import { randomBytes } from 'node:crypto';
import { DEV_ORDER_TOKEN_KEY, OrderTokens, orderTokenKey } from './order-token.js';

const key = () => randomBytes(32).toString('base64');

describe('order public token sealed with ORDER_TOKEN_KEY (spec 9a.7, NFR-07)', () => {
  it('round-trips: the sealed value reveals the issued token and does not contain it', () => {
    const tokens = new OrderTokens(key());
    const { token, sealed } = tokens.issue();
    expect(token).toMatch(/^[\w-]{43}$/);
    expect(sealed).not.toContain(token);
    const order = { publicToken: null, publicTokenSealed: sealed };
    expect(tokens.reveal(order)).toBe(token);
    expect(tokens.matches(token, order)).toBe(true);
    expect(tokens.matches(`${token}x`, order)).toBe(false);
  });

  it('two seals of one token differ (random IV)', () => {
    const tokens = new OrderTokens(key());
    const { token, sealed } = tokens.issue();
    const again = tokens.seal(token);
    expect(again).not.toBe(sealed);
    expect(tokens.reveal({ publicToken: null, publicTokenSealed: again })).toBe(token);
  });

  it('a wrong key or a tampered sealed value never matches', () => {
    const tokens = new OrderTokens(key());
    const { token, sealed } = tokens.issue();
    expect(new OrderTokens(key()).matches(token, { publicToken: null, publicTokenSealed: sealed })).toBe(false);
    const [iv, tag, data] = sealed.split('.');
    const bytes = Buffer.from(data, 'base64url');
    bytes[0] ^= 0x01;
    const tampered = [iv, tag, bytes.toString('base64url')].join('.');
    expect(tokens.matches(token, { publicToken: null, publicTokenSealed: tampered })).toBe(false);
    // A truncated tag is refused too (full 16-byte GCM tags only).
    const short = [iv, Buffer.from(tag, 'base64url').subarray(0, 12).toString('base64url'), data].join('.');
    expect(tokens.matches(token, { publicToken: null, publicTokenSealed: short })).toBe(false);
    expect(tokens.matches(token, { publicToken: null, publicTokenSealed: 'junk' })).toBe(false);
  });

  it('a legacy plain token still matches; nothing given or nothing stored never does', () => {
    const tokens = new OrderTokens(key());
    const legacy = { publicToken: 'legacy-plain-token', publicTokenSealed: null };
    expect(tokens.reveal(legacy)).toBe('legacy-plain-token');
    expect(tokens.matches('legacy-plain-token', legacy)).toBe(true);
    expect(tokens.matches('legacy-plain-tokeN', legacy)).toBe(false);
    expect(tokens.matches(undefined, legacy)).toBe(false);
    expect(tokens.matches('', { publicToken: '', publicTokenSealed: null })).toBe(false);
    expect(tokens.matches('x', { publicToken: null, publicTokenSealed: null })).toBe(false);
  });

  it('the key: the dev default outside production, the variable named in a bad-key error', () => {
    expect(orderTokenKey('development', undefined)).toBe(DEV_ORDER_TOKEN_KEY);
    expect(orderTokenKey(undefined, '')).toBe(DEV_ORDER_TOKEN_KEY);
    const own = key();
    expect(orderTokenKey('test', own)).toBe(own);
    expect(orderTokenKey('production', own)).toBe(own);
    expect(Buffer.from(DEV_ORDER_TOKEN_KEY, 'base64')).toHaveLength(32);
    expect(() => new OrderTokens('short')).toThrow(/^ORDER_TOKEN_KEY must be 32 bytes/);
  });
});
