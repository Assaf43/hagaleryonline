import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { AuthConfig } from './auth.config.js';

const KEY = Buffer.alloc(32, 1).toString('base64');

/** Reads only the given values (not process.env, where the test runner sets NODE_ENV). */
function make(env: Record<string, string>) {
  const values: Record<string, string> = { TOTP_ENCRYPTION_KEY: KEY, ...env };
  const config = {
    get: (key: string, fallback?: string) => values[key] ?? fallback,
    getOrThrow: (key: string) => values[key],
  };
  return new AuthConfig(config as unknown as ConfigService);
}

describe('AuthConfig startup warning', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(() => vi.restoreAllMocks());

  it('warns once when production runs without STOREFRONT_URL', () => {
    const config = make({ NODE_ENV: 'production' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toMatch(/STOREFRONT_URL is not set/);
    expect(config.storefrontUrl).toBe('http://localhost:4200');
  });

  it('does not warn when STOREFRONT_URL is set in production', () => {
    make({ NODE_ENV: 'production', STOREFRONT_URL: 'https://shop.example' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('does not warn outside production', () => {
    make({ NODE_ENV: 'development' });
    expect(warn).not.toHaveBeenCalled();
  });
});
