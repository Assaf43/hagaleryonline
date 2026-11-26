import { randomBytes } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUTH_IP_ATTEMPT_DEFAULT } from '../auth/auth.config.js';
import { DEV_ORDER_TOKEN_KEY } from '../orders/order-token.js';
import { DEFAULT_LIMITS } from '../orders/write-throttle.js';
import {
  assertProductionEnv,
  checkProductionEnv,
  KNOWN_DEV_VALUES,
  PRODUCTION_ENV_RULES,
  productionEnvWarnings,
} from './production-env.js';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..');
const ENV_EXAMPLE = join(here, '../../../../.env.example');

const key32 = () => randomBytes(32).toString('base64');
const secret = () => randomBytes(32).toString('hex');

/** A complete production environment with fresh random secrets. */
function validEnv(): Record<string, string | undefined> {
  return {
    NODE_ENV: 'production',
    DATABASE_URL: 'postgresql://app:pw@postgres:5432/nesto',
    PAYMENT_PROVIDER: 'real',
    SHIPPING_PROVIDER: 'manual',
    EMAIL_PROVIDER: 'real',
    SMS_PROVIDER: 'real',
    INVOICE_PROVIDER: 'real',
    MARKETING_PROVIDER: 'real',
    EMAIL_FROM: 'NESTO <no-reply@example.test>',
    SUPPORT_EMAIL: 'support@example.test',
    SITE_URL: 'https://shop.example.test',
    STOREFRONT_URL: 'https://shop.example.test',
    ADMIN_URL: 'https://admin.example.test',
    OTP_PEPPER: secret(),
    MARKETING_TOKEN_SECRET: secret(),
    CONTENT_PREVIEW_SECRET: secret(),
    INTERNAL_API_TOKEN: secret(),
    TOTP_ENCRYPTION_KEY: key32(),
    ORDER_TOKEN_KEY: key32(),
    TRUST_PROXY: 'loopback, 172.18.0.0/16',
    ALERT_EMAIL: 'alerts@example.test',
  };
}

/** `NAME=value` lines of `.env.example`, commented-out ones included (`# NAME=value`). */
function envExampleEntries(): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of readFileSync(ENV_EXAMPLE, 'utf8').split(/\r?\n/)) {
    const match = /^(?:#\s*)?([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match) entries.set(match[1], match[2].trim());
  }
  return entries;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'generated' ? [] : sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

describe('checkProductionEnv (spec 9a.3)', () => {
  it('accepts a complete production environment', () => {
    expect(checkProductionEnv(validEnv())).toEqual([]);
  });

  it('accepts a hop count as TRUST_PROXY', () => {
    expect(checkProductionEnv({ ...validEnv(), TRUST_PROXY: '1' })).toEqual([]);
  });

  it('wants INTERNAL_API_TOKEN: present, long, and not the value of another secret', () => {
    const env = validEnv();
    expect(checkProductionEnv({ ...env, INTERNAL_API_TOKEN: undefined })).toEqual(['INTERNAL_API_TOKEN: missing']);
    expect(checkProductionEnv({ ...env, INTERNAL_API_TOKEN: 'short' })).toEqual([
      'INTERNAL_API_TOKEN: too short (at least 32 characters)',
    ]);
    expect(checkProductionEnv({ ...env, INTERNAL_API_TOKEN: env['OTP_PEPPER'] })).toEqual([
      'INTERNAL_API_TOKEN: same value as OTP_PEPPER',
    ]);
  });

  it('names every missing variable', () => {
    const lines = checkProductionEnv({ NODE_ENV: 'production' });
    for (const rule of PRODUCTION_ENV_RULES) expect(lines).toContain(`${rule.name}: missing`);
    expect(lines).toHaveLength(PRODUCTION_ENV_RULES.length);
  });

  it('treats an empty or blank value as missing', () => {
    expect(checkProductionEnv({ ...validEnv(), EMAIL_FROM: '', OTP_PEPPER: '   ' })).toEqual([
      'EMAIL_FROM: missing',
      'OTP_PEPPER: missing',
    ]);
  });

  it('wants https URLs with no path, query or fragment', () => {
    const env = {
      ...validEnv(),
      SITE_URL: 'http://shop.example.test',
      STOREFRONT_URL: 'https://shop.example.test/store',
      ADMIN_URL: 'not a url',
    };
    expect(checkProductionEnv(env)).toEqual([
      'SITE_URL: must be an https URL',
      'STOREFRONT_URL: must be an https URL',
      'ADMIN_URL: must be an https URL',
    ]);
    expect(checkProductionEnv({ ...validEnv(), SITE_URL: 'https://shop.example.test/?a=1' })).toEqual([
      'SITE_URL: must be an https URL',
    ]);
    expect(checkProductionEnv({ ...validEnv(), SITE_URL: 'https://shop.example.test/' })).toEqual([]);
  });

  it('wants secrets of at least 32 characters', () => {
    expect(checkProductionEnv({ ...validEnv(), OTP_PEPPER: 'x'.repeat(31) })).toEqual([
      'OTP_PEPPER: too short (at least 32 characters)',
    ]);
  });

  it('wants keys of exactly 32 bytes in base64', () => {
    const env = {
      ...validEnv(),
      TOTP_ENCRYPTION_KEY: randomBytes(16).toString('base64'),
      ORDER_TOKEN_KEY: 'not base64 at all, but long enough to pass a length check',
    };
    expect(checkProductionEnv(env)).toEqual([
      'TOTP_ENCRYPTION_KEY: must be 32 bytes, base64',
      'ORDER_TOKEN_KEY: must be 32 bytes, base64',
    ]);
  });

  it('refuses the development defaults', () => {
    const env = {
      ...validEnv(),
      OTP_PEPPER: 'dev-otp-pepper-not-for-production',
      MARKETING_TOKEN_SECRET: 'dev-marketing-token-secret-not-for-production',
      CONTENT_PREVIEW_SECRET: 'dev-content-preview-secret-not-for-production',
      ORDER_TOKEN_KEY: DEV_ORDER_TOKEN_KEY,
    };
    expect(checkProductionEnv(env)).toEqual([
      'OTP_PEPPER: is a development value',
      'MARKETING_TOKEN_SECRET: is a development value',
      'CONTENT_PREVIEW_SECRET: is a development value',
      'ORDER_TOKEN_KEY: is a development value',
    ]);
  });

  it('refuses a DATABASE_URL with the development password, never printing it', () => {
    const env = { ...validEnv(), DATABASE_URL: 'postgresql://app:hagalery_dev@db:5432/nesto' };
    const lines = checkProductionEnv(env);
    expect(lines).toEqual(['DATABASE_URL: uses the development password']);
    expect(lines.join()).not.toContain('hagalery_dev');
  });

  it('refuses two secrets or keys with the same value', () => {
    const shared = key32();
    const env = { ...validEnv(), OTP_PEPPER: shared, TOTP_ENCRYPTION_KEY: shared, ORDER_TOKEN_KEY: shared };
    expect(checkProductionEnv(env)).toEqual([
      'TOTP_ENCRYPTION_KEY: same value as OTP_PEPPER',
      'ORDER_TOKEN_KEY: same value as OTP_PEPPER',
    ]);
  });

  it('refuses a TRUST_PROXY that trusts every client', () => {
    for (const value of ['true', '*', ' true ']) {
      expect(checkProductionEnv({ ...validEnv(), TRUST_PROXY: value })).toEqual([
        'TRUST_PROXY: must name the proxy, not trust everyone',
      ]);
    }
  });

  it('never prints a value', () => {
    const sentinel = 'SENTINEL-VALUE-must-never-be-printed';
    const env: Record<string, string> = {};
    for (const rule of PRODUCTION_ENV_RULES) env[rule.name] = sentinel;
    env.NODE_ENV = 'production';
    const lines = checkProductionEnv(env);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).not.toContain('SENTINEL');
  });
});

describe('productionEnvWarnings', () => {
  it('names each throttle override and its number', () => {
    const warnings = productionEnvWarnings({ ...validEnv(), THROTTLE_OTP_LIMIT: '500', AUTH_IP_ATTEMPT_LIMIT: '100' });
    expect(warnings).toEqual([
      'THROTTLE_OTP_LIMIT=500 overrides the production limit (10)',
      'AUTH_IP_ATTEMPT_LIMIT=100 overrides the production limit (30)',
    ]);
  });

  it('is empty without overrides', () => {
    expect(productionEnvWarnings(validEnv())).toEqual([]);
  });

  it('warns, but does not refuse, when ALERT_EMAIL is unset', () => {
    const env = { ...validEnv(), ALERT_EMAIL: ' ' };
    expect(productionEnvWarnings(env)).toEqual([
      'ALERT_EMAIL is not set: no alert e-mails for errors or failed backups',
    ]);
    expect(checkProductionEnv(env)).toEqual([]);
  });
});

describe('assertProductionEnv', () => {
  afterEach(() => vi.restoreAllMocks());

  const exitSpy = () =>
    vi.fn((code: number): never => {
      throw new Error(`exit ${code}`);
    });

  it('does nothing outside production', () => {
    const exit = exitSpy();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    assertProductionEnv({ NODE_ENV: 'development' }, exit);
    assertProductionEnv({}, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it('refuses to start in production with a problem, naming the variable only', () => {
    const exit = exitSpy();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const env = { ...validEnv(), OTP_PEPPER: undefined, CONTENT_PREVIEW_SECRET: 'SENTINEL-short' };
    expect(() => assertProductionEnv(env, exit)).toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(error).toHaveBeenCalledWith(
      'Refusing to start in production:\n- OTP_PEPPER: missing\n- CONTENT_PREVIEW_SECRET: too short (at least 32 characters)',
    );
    expect(JSON.stringify(error.mock.calls)).not.toContain('SENTINEL');
  });

  it('starts with a complete environment and only warns about throttle overrides', () => {
    const exit = exitSpy();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    assertProductionEnv({ ...validEnv(), THROTTLE_CHECKOUT_LIMIT: '40' }, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('THROTTLE_CHECKOUT_LIMIT=40 overrides the production limit (20)');
  });
});

describe('.env.example', () => {
  it('every .env.example secret is a known dev value', () => {
    const checked = new Set(
      PRODUCTION_ENV_RULES.filter((r) => r.kind === 'secret' || r.kind === 'key32').map((r) => r.name),
    );
    for (const [name, value] of envExampleEntries()) {
      if (!value || !(checked.has(name) || /(SECRET|PEPPER|KEY|PASSWORD)$/.test(name))) continue;
      expect(KNOWN_DEV_VALUES.has(value), `${name} in .env.example`).toBe(true);
    }
  });

  it('every variable the API reads is documented', () => {
    const names = new Set<string>(PRODUCTION_ENV_RULES.map((r) => r.name));
    const pattern =
      /(?:config\.(?:get|getOrThrow)(?:<[^>]*>)?\(\s*['"`]|process\.env\.|process\.env\[\s*['"])([A-Z][A-Z0-9_]*)/g;
    for (const file of sourceFiles(SRC)) {
      for (const match of readFileSync(file, 'utf8').matchAll(pattern)) names.add(match[1]);
    }
    // `THROTTLE_${bucket}_LIMIT` is read with a template: one variable per bucket.
    names.delete('THROTTLE_');
    for (const bucket of Object.keys(DEFAULT_LIMITS)) names.add(`THROTTLE_${bucket.toUpperCase()}_LIMIT`);
    expect(names.size).toBeGreaterThan(30);
    const documented = envExampleEntries();
    expect([...names].filter((name) => !documented.has(name))).toEqual([]);
  });
});

describe('production throttle values (spec 9a.3)', () => {
  it('are the reviewed per-15-minute limits', () => {
    expect(DEFAULT_LIMITS).toEqual({
      checkout: 20,
      retry: 20,
      sandbox: 60,
      coupon: 20,
      cancel: 20,
      delivery: 20,
      otp: 10,
      signin: 20,
      account: 60,
      lookup: 10,
      lookup_number: 5,
      support: 5,
      support_order: 5,
      store_otp: 30,
      store_lookup: 60,
      store_verify: 60,
      newsletter: 10,
      newsletter_unsubscribe: 60,
    });
    expect(AUTH_IP_ATTEMPT_DEFAULT).toBe(30);
  });
});
