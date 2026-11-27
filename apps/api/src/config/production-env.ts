import { AUTH_IP_ATTEMPT_DEFAULT } from '../auth/auth.config.js';
import { APP_ENVS } from './app-env.js';
import { DEV_PREVIEW_SECRET } from '../content/preview-token.js';
import { DEV_PEPPER } from '../customers/otp.service.js';
import { DEV_TOKEN_SECRET } from '../marketing/marketing-tokens.js';
import { isAllowedS3Endpoint } from '../media/s3-storage.js';
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
 * - `trust-proxy`: set, and not `true` / `*` / `0.0.0.0/0` / `::/0`, alone or in a list (each would trust every
 *   client's `X-Forwarded-For`), and no range wider than /8 (IPv4) or /16 (IPv6) (`0.0.0.0/1,128.0.0.0/1` is the
 *   same catch-all, split);
 * - `database-url`: set, not the development password, and a password of at least 20 characters;
 * - `s3`: exactly `s3` (production photos live in object storage, never on the app's disk);
 * - `s3-endpoint`: an `https:` URL, or `http:` only with `APP_ENV=staging` and a local host (no dot, or `*.localhost`,
 *   e.g. the rehearsal's `http://minio:9000`): `isAllowedS3Endpoint` of `media/s3-storage.ts`.
 *
 * `APP_ENV` is checked apart from the rules: unset or `production` / `staging` (see `app-env.ts`).
 */
export type EnvRule = {
  name: string;
  kind: 'present' | 'url' | 'secret' | 'key32' | 'trust-proxy' | 'database-url' | 's3' | 's3-endpoint';
};

export const PRODUCTION_ENV_RULES: readonly EnvRule[] = [
  { name: 'DATABASE_URL', kind: 'database-url' },
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
  { name: 'STORAGE_PROVIDER', kind: 's3' },
  { name: 'S3_ENDPOINT', kind: 's3-endpoint' },
  { name: 'S3_REGION', kind: 'present' },
  { name: 'S3_ACCESS_KEY_ID', kind: 'present' },
  { name: 'S3_SECRET_ACCESS_KEY', kind: 'present' },
  { name: 'S3_PUBLIC_BUCKET', kind: 'present' },
  { name: 'S3_PRIVATE_BUCKET', kind: 'present' },
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
const MIN_DB_PASSWORD_LENGTH = 20;
/** `TRUST_PROXY` entries that trust every hop. */
const TRUST_EVERYONE: ReadonlySet<string> = new Set(['true', '*', '0.0.0.0/0', '::/0']);
/** The widest `TRUST_PROXY` ranges accepted: a /8 (IPv4) and a /16 (IPv6); the edge network is a /24. */
const MIN_IPV4_PREFIX = 8;
const MIN_IPV6_PREFIX = 16;
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

/** The password of a connection string, decoded (empty when it has none or is not a URL). */
function databasePassword(value: string): string {
  try {
    return decodeURIComponent(new URL(value).password);
  } catch {
    return '';
  }
}

/**
 * True when one `TRUST_PROXY` entry is an address range wider than /8 (IPv4) or /16 (IPv6), e.g. the split catch-all
 * `0.0.0.0/1,128.0.0.0/1`. Netmask notation (`10.0.0.0/255.0.0.0`) and IPv4-mapped IPv6 ranges in any notation
 * (`::ffff:0.0.0.0/96`, `::ffff:0:0/96`, `0:0:0:0:0:ffff:0.0.0.0/96`) count by their real width, as proxy-addr reads
 * them; an entry with an unreadable address or prefix counts as wide (refused rather than guessed).
 */
function isWideRange(entry: string): boolean {
  const slash = entry.indexOf('/');
  if (slash < 0) return false;
  const address = entry.slice(0, slash).toLowerCase();
  const suffix = entry.slice(slash + 1);
  const v6 = address.includes(':');
  let prefix: number;
  if (/^\d{1,3}$/.test(suffix)) prefix = Number(suffix);
  else if (!v6 && /^\d{1,3}(\.\d{1,3}){3}$/.test(suffix)) prefix = netmaskBits(suffix);
  else return true;
  if (!v6) return prefix < MIN_IPV4_PREFIX;
  const groups = ipv6Groups(address);
  if (!groups) return true;
  // proxy-addr turns an IPv4-mapped range (::ffff:0:0/96) into the IPv4 range of width prefix - 96.
  if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) return prefix - 96 < MIN_IPV4_PREFIX;
  return prefix < MIN_IPV6_PREFIX;
}

/**
 * The eight 16-bit groups of an IPv6 address in any notation (`::` shorthand, an embedded dotted IPv4 tail, zone ids
 * are not accepted), or null when it is not one.
 */
function ipv6Groups(address: string): number[] | null {
  let text = address;
  const tail: number[] = [];
  const dotted = /^(.*:)(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (dotted) {
    const octets = dotted[2].split('.').map(Number);
    if (octets.some((octet) => octet > 255)) return null;
    tail.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3]);
    text = dotted[1].endsWith('::') ? dotted[1] : dotted[1].slice(0, -1);
  }
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string): number[] | null => {
    if (!part) return [];
    const out: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      out.push(parseInt(group, 16));
    }
    return out;
  };
  const head = parse(halves[0]);
  const rest = halves.length === 2 ? parse(halves[1]) : [];
  if (!head || !rest) return null;
  const given = head.length + rest.length + tail.length;
  if (halves.length === 1) return given === 8 ? [...head, ...tail] : null;
  if (given > 7) return null;
  return [...head, ...Array.from({ length: 8 - given }, () => 0), ...rest, ...tail];
}

/** The leading one-bits of a dotted netmask (`255.0.0.0` → 8); -1 when it is not a netmask. */
function netmaskBits(mask: string): number {
  const bits = mask
    .split('.')
    .map((part) => Number(part).toString(2).padStart(8, '0'))
    .join('');
  if (bits.length !== 32 || !/^1*0*$/.test(bits)) return -1;
  return bits.replace(/0+$/, '').length;
}

/** The problem of one variable, or null. */
function problemOf(rule: EnvRule, value: string, staging: boolean): string | null {
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
      if (value.split(',').some((part) => TRUST_EVERYONE.has(part.trim())))
        return 'must name the proxy, not trust everyone';
      return value.split(',').some((part) => isWideRange(part.trim()))
        ? 'must name the proxy, not a range wider than /8 (IPv4) or /16 (IPv6)'
        : null;
    case 'database-url':
      if (value.includes('hagalery_dev')) return 'uses the development password';
      return databasePassword(value).length < MIN_DB_PASSWORD_LENGTH
        ? `password too short (at least ${MIN_DB_PASSWORD_LENGTH} characters)`
        : null;
    case 's3':
      return value === 's3' ? null : 'must be s3';
    case 's3-endpoint':
      return isAllowedS3Endpoint(value, staging)
        ? null
        : 'must be an https URL (http only for a local host in staging)';
  }
}

/** One line per problem of a production environment (empty when it may start); values are never included. */
export function checkProductionEnv(env: Record<string, string | undefined>): string[] {
  const problems: string[] = [];
  const appEnv = env.APP_ENV?.trim() ?? '';
  if (appEnv && !(APP_ENVS as readonly string[]).includes(appEnv))
    problems.push('APP_ENV: must be production or staging');
  const staging = appEnv === 'staging';
  /** Secret / key values seen so far → the first variable holding each. */
  const seen = new Map<string, string>();
  for (const rule of PRODUCTION_ENV_RULES) {
    const value = env[rule.name]?.trim() ?? '';
    if (!value) {
      problems.push(`${rule.name}: missing`);
      continue;
    }
    const problem = problemOf(rule, value, staging);
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
  const warnings: string[] = [];
  if (env.APP_ENV?.trim() === 'staging') warnings.push('Staging mode: mock providers allowed');
  warnings.push(
    ...limits
      .filter(([name]) => env[name]?.trim())
      .map(([name, limit]) => `${name}=${Number(env[name])} overrides the production limit (${limit})`),
  );
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
