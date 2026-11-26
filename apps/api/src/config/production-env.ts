import { AUTH_IP_ATTEMPT_DEFAULT } from '../auth/auth.config.js';
import { DEV_PREVIEW_SECRET } from '../content/preview-token.js';
import { DEV_PEPPER } from '../customers/otp.service.js';
import { DEV_TOKEN_SECRET } from '../marketing/marketing-tokens.js';
import { DEV_ORDER_TOKEN_KEY } from '../orders/order-token.js';
import { DEFAULT_LIMITS, type ThrottleBucket } from '../orders/write-throttle.js';

/**
 * The production configuration check (spec 9a.3, NFR-07): before Nest builds anything, a production API with a missing
 * or weak secret refuses to start and lists every problem at once. Lines name the variable, never its value. The
 * per-module checks (mocks refuse production, `siteUrl`, peppers) stay as a second line behind this one.
 *
 * - `present`: set and not blank;
 * - `url`: an `https:` URL with no path, query or fragment;
 * - `secret`: at least 32 characters;
 * - `key32`: base64 of exactly 32 bytes;
 * - `trust-proxy`: set, and not `true` / `*` (which would trust every client's `X-Forwarded-For`).
 */
export type EnvRule = { name: string; kind: 'present' | 'url' | 'secret' | 'key32' | 'trust-proxy' };

export const PRODUCTION_ENV_RULES: readonly EnvRule[] = [
  { name: 'DATABASE_URL', kind: 'present' },
  { name: 'PAYMENT_PROVIDER', kind: 'present' },
  { name: 'SHIPPING_PROVIDER', kind: 'present' },
  { name: 'EMAIL_PROVIDER', kind: 'present' },
  { name: 'SMS_PROVIDER', kind: 'present' },
  { name: 'INVOICE_PROVIDER', kind: 'present' },
  { name: 'MARKETING_PROVIDER', kind: 'present' },
  { name: 'EMAIL_FROM', kind: 'present' },
  { name: 'SUPPORT_EMAIL', kind: 'present' },
  { name: 'SITE_URL', kind: 'url' },
  { name: 'STOREFRONT_URL', kind: 'url' },
  { name: 'ADMIN_URL', kind: 'url' },
  { name: 'OTP_PEPPER', kind: 'secret' },
  { name: 'MARKETING_TOKEN_SECRET', kind: 'secret' },
  { name: 'CONTENT_PREVIEW_SECRET', kind: 'secret' },
  { name: 'INTERNAL_API_TOKEN', kind: 'secret' },
  { name: 'TOTP_ENCRYPTION_KEY', kind: 'key32' },
  { name: 'ORDER_TOKEN_KEY', kind: 'key32' },
  { name: 'TRUST_PROXY', kind: 'trust-proxy' },
];

/** The development defaults and every secret value written in `.env.example`: never accepted in production. */
export const KNOWN_DEV_VALUES: ReadonlySet<string> = new Set([
  DEV_PEPPER,
  DEV_TOKEN_SECRET,
  DEV_PREVIEW_SECRET,
  DEV_ORDER_TOKEN_KEY,
  // POSTGRES_PASSWORD of .env.example (the local Docker database).
  'hagalery_dev',
]);

const MIN_SECRET_LENGTH = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function isHttpsOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  return url.protocol === 'https:' && url.pathname === '/' && !url.search && !url.hash && !value.includes('?');
}

/** The problem of one variable, or null. */
function problemOf(rule: EnvRule, value: string): string | null {
  switch (rule.kind) {
    case 'present':
      return null;
    case 'url':
      return isHttpsOrigin(value) ? null : 'must be an https URL';
    case 'secret':
      if (value.length < MIN_SECRET_LENGTH) return `too short (at least ${MIN_SECRET_LENGTH} characters)`;
      return KNOWN_DEV_VALUES.has(value) ? 'is a development value' : null;
    case 'key32':
      if (!BASE64.test(value) || Buffer.from(value, 'base64').length !== 32) return 'must be 32 bytes, base64';
      return KNOWN_DEV_VALUES.has(value) ? 'is a development value' : null;
    case 'trust-proxy':
      return value === 'true' || value === '*' ? 'must name the proxy, not trust everyone' : null;
  }
}

/** One line per problem of a production environment (empty when it may start); values are never included. */
export function checkProductionEnv(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  /** Secret / key values seen so far → the first variable holding each. */
  const seen = new Map<string, string>();
  for (const rule of PRODUCTION_ENV_RULES) {
    const value = env[rule.name]?.trim() ?? '';
    if (!value) {
      problems.push(`${rule.name}: missing`);
      continue;
    }
    const problem = problemOf(rule, value);
    if (rule.name === 'DATABASE_URL' && value.includes('hagalery_dev')) {
      problems.push('DATABASE_URL: uses the development password');
      continue;
    }
    if (problem) {
      problems.push(`${rule.name}: ${problem}`);
      continue;
    }
    if (rule.kind !== 'secret' && rule.kind !== 'key32') continue;
    const first = seen.get(value);
    if (first) problems.push(`${rule.name}: same value as ${first}`);
    else seen.set(value, rule.name);
  }
  return problems;
}

/**
 * The rate-limit overrides set in production, by name and number: production runs the reviewed defaults
 * (`DEFAULT_LIMITS`, `AUTH_IP_ATTEMPT_DEFAULT`), so an override is worth a warning but no refusal.
 */
export function productionEnvWarnings(env: Record<string, string | undefined>): string[] {
  const limits: [string, number][] = [
    ...Object.entries(DEFAULT_LIMITS).map(([bucket, limit]): [string, number] => [
      `THROTTLE_${(bucket as ThrottleBucket).toUpperCase()}_LIMIT`,
      limit,
    ]),
    ['AUTH_IP_ATTEMPT_LIMIT', AUTH_IP_ATTEMPT_DEFAULT],
  ];
  const warnings = limits
    .filter(([name]) => env[name]?.trim())
    .map(([name, limit]) => `${name}=${Number(env[name])} overrides the production limit (${limit})`);
  if (!env.ALERT_EMAIL?.trim()) warnings.push('ALERT_EMAIL is not set: no alert e-mails for errors or failed backups');
  return warnings;
}

/**
 * Called first in `main.ts`, before `NestFactory.create` (no port is opened). Only when `NODE_ENV=production`:
 * problems → one error listing them all, then exit code 1. `process.env` already holds the `.env` file here
 * (`ConfigModule.forRoot` loads it while `AppModule` is imported), so this checks what the API would run with.
 */
export function assertProductionEnv(
  env: Record<string, string | undefined> = process.env,
  exit: (code: number) => never = (code) => process.exit(code),
): void {
  if (env.NODE_ENV !== 'production') return;
  for (const warning of productionEnvWarnings(env)) console.warn(warning);
  const problems = checkProductionEnv(env);
  if (!problems.length) return;
  console.error(`Refusing to start in production:\n${problems.map((line) => `- ${line}`).join('\n')}`);
  exit(1);
}
