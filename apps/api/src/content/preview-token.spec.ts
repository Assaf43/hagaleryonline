import { PreviewTokens, resolvePreviewSecret, signPreview, verifyPreview } from './preview-token.js';

describe('landing preview tokens', () => {
  const secret = 'test-preview-secret-0123456789abcdef';
  const now = new Date('2026-11-18T10:00:00.000Z');
  const minutes = (m: number) => new Date(now.getTime() + m * 60_000);

  it('a fresh token opens its own page for 30 minutes', () => {
    const token = signPreview(7, now, secret);
    expect(token).toMatch(/^7\.\d+\.[A-Za-z0-9_-]{43}$/);
    expect(verifyPreview(token, 7, now, secret)).toBe(true);
    expect(verifyPreview(token, 7, minutes(29.9), secret)).toBe(true);
  });

  it('expires at 30 minutes', () => {
    const token = signPreview(7, now, secret);
    expect(verifyPreview(token, 7, minutes(30), secret)).toBe(false);
    expect(verifyPreview(token, 7, minutes(31), secret)).toBe(false);
  });

  it('is bound to the page id', () => {
    const token = signPreview(7, now, secret);
    expect(verifyPreview(token, 8, now, secret)).toBe(false);
    // Changing the id inside the token breaks the signature.
    expect(verifyPreview(token.replace(/^7\./, '8.'), 8, now, secret)).toBe(false);
  });

  it('refuses a tampered expiry or signature, another secret and junk', () => {
    const token = signPreview(7, now, secret);
    const [id, exp, sig] = token.split('.');
    const later = String(Number(exp) + 60 * 60_000);
    expect(verifyPreview(`${id}.${later}.${sig}`, 7, minutes(40), secret)).toBe(false);
    const flipped = sig.slice(0, -1) + (sig.endsWith('A') ? 'B' : 'A');
    expect(verifyPreview(`${id}.${exp}.${flipped}`, 7, now, secret)).toBe(false);
    expect(verifyPreview(token, 7, now, 'another-secret-0123456789abcdefgh')).toBe(false);
    for (const junk of ['', 'x', '7..', `${token}.x`, `${token}x`, ' '.repeat(300), `07.${exp}.${sig}`])
      expect(verifyPreview(junk, 7, now, secret)).toBe(false);
  });

  it('PreviewTokens signs and verifies with its secret', () => {
    const tokens = new PreviewTokens(secret);
    const token = tokens.sign(3, now);
    expect(tokens.verify(token, 3, minutes(5))).toBe(true);
    expect(new PreviewTokens('other-secret-0123456789abcdefghijk').verify(token, 3, minutes(5))).toBe(false);
    expect(tokens.pageOf(token, minutes(5))).toBe(3);
    expect(tokens.pageOf(token, minutes(30))).toBeNull();
    expect(tokens.pageOf(token.replace(/^3\./, '4.'), now)).toBeNull();
    expect(tokens.pageOf('junk', now)).toBeNull();
  });

  it('production needs its own secret of at least 32 characters; dev falls back to a fixed one', () => {
    expect(() => resolvePreviewSecret(undefined, 'production')).toThrow(/CONTENT_PREVIEW_SECRET/);
    expect(() => resolvePreviewSecret('short', 'production')).toThrow(/at least 32/);
    expect(resolvePreviewSecret('x'.repeat(32), 'production')).toBe('x'.repeat(32));
    expect(resolvePreviewSecret(undefined, 'development')).toBe(resolvePreviewSecret('', undefined));
    expect(resolvePreviewSecret('mine', 'test')).toBe('mine');
  });
});
