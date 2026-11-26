import type { ConfigService } from '@nestjs/config';
import { allowsMockProviders } from './app-env.js';

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('allowsMockProviders', () => {
  it('allows the mocks outside production', () => {
    expect(allowsMockProviders({})).toBe(true);
    expect(allowsMockProviders({ NODE_ENV: 'development' })).toBe(true);
    expect(allowsMockProviders({ NODE_ENV: 'test', APP_ENV: 'anything' })).toBe(true);
  });

  it('mocks refuse production', () => {
    expect(allowsMockProviders({ NODE_ENV: 'production' })).toBe(false);
    expect(allowsMockProviders({ NODE_ENV: 'production', APP_ENV: 'production' })).toBe(false);
    expect(allowsMockProviders({ NODE_ENV: 'production', APP_ENV: 'Staging' })).toBe(false);
    expect(allowsMockProviders({ NODE_ENV: 'production', APP_ENV: ' ' })).toBe(false);
  });

  it('mocks allowed with APP_ENV=staging', () => {
    expect(allowsMockProviders({ NODE_ENV: 'production', APP_ENV: 'staging' })).toBe(true);
    expect(allowsMockProviders({ NODE_ENV: 'production', APP_ENV: ' staging ' })).toBe(true);
  });

  it('reads a ConfigService the same way', () => {
    expect(allowsMockProviders(config({ NODE_ENV: 'production' }))).toBe(false);
    expect(allowsMockProviders(config({ NODE_ENV: 'production', APP_ENV: 'staging' }))).toBe(true);
    expect(allowsMockProviders(config({}))).toBe(true);
  });
});
