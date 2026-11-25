import { buildStorefrontCsp } from './csp';

describe('buildStorefrontCsp', () => {
  it('builds the exact policy with the nonce on scripts and styles', () => {
    expect(buildStorefrontCsp('abc123==')).toBe(
      "default-src 'self'; script-src 'self' 'nonce-abc123=='; style-src 'self' 'nonce-abc123=='; " +
        "style-src-attr 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; " +
        "frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'; " +
        "manifest-src 'self'",
    );
  });

  it('appends extras to their directive', () => {
    const csp = buildStorefrontCsp('n', {
      'script-src': ['https://www.googletagmanager.com'],
      'connect-src': ['https://a.example.test', 'https://b.example.test'],
      'img-src': ['https://img.example.test'],
      'frame-src': ['https://frame.example.test'],
    });
    const directives = csp.split('; ');
    expect(directives).toContain("script-src 'self' 'nonce-n' https://www.googletagmanager.com");
    expect(directives).toContain("connect-src 'self' https://a.example.test https://b.example.test");
    expect(directives).toContain("img-src 'self' data: blob: https://img.example.test");
    expect(directives).toContain("frame-src 'none' https://frame.example.test");
    expect(directives).toContain("style-src 'self' 'nonce-n'");
  });

  it('ignores an empty extra list', () => {
    expect(buildStorefrontCsp('n', { 'script-src': [] })).toBe(buildStorefrontCsp('n'));
  });
});
