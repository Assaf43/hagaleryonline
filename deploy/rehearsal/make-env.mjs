#!/usr/bin/env node
// Writes deploy/rehearsal/.env.rehearsal (git-ignored) for the local rehearsal (spec 9b.7):
//   node deploy/rehearsal/make-env.mjs --age-recipient age1...
// Every secret is fresh from crypto.randomBytes. Only the age PUBLIC key is passed in; the private key never comes
// near this script. It refuses to overwrite an existing file and prints only the path and the variable names.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const AGE_RECIPIENT = /^age1[0-9a-z]{58}$/;
export const DEFAULT_OUT = join(dirname(fileURLToPath(import.meta.url)), '.env.rehearsal');

/** URL-safe random text (base64url: letters, digits, `-`, `_`), so it fits in a connection string and an env file. */
const secret = (chars) =>
  randomBytes(Math.ceil((chars * 3) / 4))
    .toString('base64url')
    .slice(0, chars);
/** 32 random bytes, base64 (the API's `key32` rule). */
const key32 = () => randomBytes(32).toString('base64');

/** The names that hold secrets (each must be unique; the spec checks it). */
export const SECRET_NAMES = [
  'POSTGRES_PASSWORD',
  'NESTO_OWNER_PASSWORD',
  'NESTO_APP_PASSWORD',
  'NESTO_BACKUP_PASSWORD',
  'TOTP_ENCRYPTION_KEY',
  'ORDER_TOKEN_KEY',
  'OTP_PEPPER',
  'MARKETING_TOKEN_SECRET',
  'CONTENT_PREVIEW_SECRET',
  'INTERNAL_API_TOKEN',
  'PAYMENT_SANDBOX_SECRET',
  'MARKETING_MOCK_SECRET',
  'MINIO_ROOT_PASSWORD',
  'S3_SECRET_ACCESS_KEY',
  'BACKUP_S3_SECRET_ACCESS_KEY',
  'BACKUP_READ_SECRET_ACCESS_KEY',
];

/**
 * The rehearsal environment as ordered [name, value] pairs. Pure apart from the random values.
 * @param {{ ageRecipient: string, imageTag?: string }} opts
 */
export function buildRehearsalEnv(opts) {
  const ageRecipient = String(opts?.ageRecipient ?? '');
  if (!AGE_RECIPIENT.test(ageRecipient)) throw new Error('--age-recipient must be an age public key (age1...)');

  const db = { owner: secret(32), app: secret(32), backup: secret(32) };
  const dbUrl = (role, password) => `postgresql://${role}:${password}@postgres:5432/nesto`;
  const site = 'https://nesto.localhost';
  const minio = 'http://minio:9000';

  /** @type {[string, string][]} */
  const env = [
    // Compose / images: deploy.sh sets IMAGE_TAG on the command line; left empty here on purpose.
    ['APP_ENV', 'staging'],
    ['NODE_ENV', 'production'],
    // postgres
    ['POSTGRES_PASSWORD', secret(32)],
    ['NESTO_OWNER_PASSWORD', db.owner],
    ['NESTO_APP_PASSWORD', db.app],
    ['NESTO_BACKUP_PASSWORD', db.backup],
    // migrate / api / backup connection strings
    ['MIGRATE_DATABASE_URL', dbUrl('nesto_owner', db.owner)],
    ['DATABASE_URL', dbUrl('nesto_app', db.app)],
    ['BACKUP_DATABASE_URL', dbUrl('nesto_backup', db.backup)],
    // api
    ['TRUST_PROXY', '172.31.240.0/24'],
    ['SITE_URL', site],
    ['STOREFRONT_URL', site],
    ['ADMIN_URL', 'https://admin.nesto.localhost'],
    ['TOTP_ENCRYPTION_KEY', key32()],
    ['ORDER_TOKEN_KEY', key32()],
    ['OTP_PEPPER', secret(48)],
    ['MARKETING_TOKEN_SECRET', secret(48)],
    ['CONTENT_PREVIEW_SECRET', secret(48)],
    ['INTERNAL_API_TOKEN', secret(48)],
    ['STORAGE_PROVIDER', 's3'],
    ['S3_ENDPOINT', minio],
    ['S3_REGION', 'us-east-1'],
    ['S3_ACCESS_KEY_ID', 'app'],
    ['S3_SECRET_ACCESS_KEY', secret(48)],
    ['S3_PUBLIC_BUCKET', 'nesto-media-public'],
    ['S3_PRIVATE_BUCKET', 'nesto-media-private'],
    ['S3_FORCE_PATH_STYLE', 'true'],
    ['PAYMENT_PROVIDER', 'sandbox'],
    ['PAYMENT_SANDBOX_SECRET', secret(48)],
    ['SHIPPING_PROVIDER', 'manual'],
    ['EMAIL_PROVIDER', 'mock'],
    ['SMS_PROVIDER', 'mock'],
    ['INVOICE_PROVIDER', 'mock'],
    ['MARKETING_PROVIDER', 'mock'],
    ['MARKETING_MOCK_SECRET', secret(48)],
    ['EMAIL_FROM', 'NESTO <no-reply@example.test>'],
    ['SUPPORT_EMAIL', 'support@example.test'],
    // Set at runtime only, never written here.
    ['ALERT_EMAIL', ''],
    ['BACKUP_EXPECTED', 'true'],
    // web
    ['NG_ALLOWED_HOSTS', 'nesto.localhost'],
    ['STOREFRONT_CSP', 'enforce'],
    ['SEO_INDEXING', 'false'],
    // caddy
    ['SITE_HOST', 'nesto.localhost'],
    ['ADMIN_HOST', 'admin.nesto.localhost'],
    ['S3_PUBLIC_UPSTREAM', minio],
    ['CADDY_GLOBAL_OPTIONS', 'local_certs'],
    // backup
    ['BACKUP_AGE_RECIPIENT', ageRecipient],
    ['BACKUP_AT', '02:30'],
    ['BACKUP_S3_ENDPOINT', minio],
    ['BACKUP_S3_REGION', 'us-east-1'],
    ['BACKUP_S3_BUCKET', 'nesto-backups'],
    ['BACKUP_S3_ACCESS_KEY_ID', 'backup-writer'],
    ['BACKUP_S3_SECRET_ACCESS_KEY', secret(48)],
    // Restore-time keys: read only by minio-setup here; restore takes them from its own one-off environment.
    ['BACKUP_READ_ACCESS_KEY_ID', 'backup-reader'],
    ['BACKUP_READ_SECRET_ACCESS_KEY', secret(48)],
    // MinIO (rehearsal overlay only)
    ['MINIO_ROOT_USER', 'nesto-root'],
    ['MINIO_ROOT_PASSWORD', secret(48)],
  ];
  if (opts.imageTag) env.unshift(['IMAGE_TAG', String(opts.imageTag)]);
  return env;
}

/** The env file text. Values never hold `$`, quotes, spaces before `#` or newlines, so they need no quoting. */
export function formatEnv(pairs) {
  const head = [
    '# Generated by deploy/rehearsal/make-env.mjs for the local rehearsal only. Git-ignored: never commit or share it.',
    '# Delete it (and the rehearsal volumes, with the owner) when the rehearsal is over.',
  ];
  return `${[...head, ...pairs.map(([name, value]) => `${name}=${value}`)].join('\n')}\n`;
}

/** Writes the file (mode 0600, refusing to overwrite); returns the names written. */
export function writeRehearsalEnv(path, opts) {
  if (existsSync(path)) throw new Error(`${path} already exists; refusing to overwrite it (delete it first)`);
  const pairs = buildRehearsalEnv(opts);
  writeFileSync(path, formatEnv(pairs), { flag: 'wx', mode: 0o600 });
  return pairs.map(([name]) => name);
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--age-recipient') opts.ageRecipient = argv[++i];
    else if (arg === '--out') opts.out = argv[++i];
    else throw new Error('unknown argument (use --age-recipient age1... [--out <file>])');
  }
  return opts;
}

function main() {
  try {
    const { ageRecipient, out = DEFAULT_OUT } = parseArgs(process.argv.slice(2));
    const names = writeRehearsalEnv(out, { ageRecipient });
    const shown = relative(process.cwd(), resolve(out));
    console.log(`Wrote ${shown && !shown.startsWith('..') ? shown : resolve(out)}`);
    console.log(`Variables: ${names.join(', ')}`);
  } catch (error) {
    console.error(`make-env: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
