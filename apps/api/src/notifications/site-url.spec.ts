import type { ConfigService } from '@nestjs/config';
import { resolveSiteUrl } from './site-url.js';

/** Reads only the given values (not process.env, where the test runner sets NODE_ENV). */
function config(values: Record<string, string>): ConfigService {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

describe('resolveSiteUrl', () => {
  it('uses SITE_URL and strips trailing slashes', () => {
    expect(resolveSiteUrl(config({ SITE_URL: 'https://shop.example//' }))).toBe('https://shop.example');
  });

  it('falls back to STOREFRONT_URL when SITE_URL is unset', () => {
    expect(resolveSiteUrl(config({ STOREFRONT_URL: 'http://localhost:4201/' }))).toBe('http://localhost:4201');
  });

  it('defaults to the local storefront outside production', () => {
    expect(resolveSiteUrl(config({ NODE_ENV: 'development' }))).toBe('http://localhost:4200');
  });

  it('stops startup in production when neither address is set, naming SITE_URL', () => {
    expect(() => resolveSiteUrl(config({ NODE_ENV: 'production' }))).toThrow(/SITE_URL/);
  });

  it('accepts STOREFRONT_URL in production', () => {
    expect(resolveSiteUrl(config({ NODE_ENV: 'production', STOREFRONT_URL: 'https://shop.example' }))).toBe(
      'https://shop.example',
    );
  });

  it.each(['shop.example', '/relative', 'ftp://shop.example', 'not a url', 'https://shop.example?x=1'])(
    'refuses %s',
    (value) => {
      expect(() => resolveSiteUrl(config({ SITE_URL: value }))).toThrow(/SITE_URL/);
    },
  );
});
