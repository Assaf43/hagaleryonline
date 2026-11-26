/**
 * Server CLI for what must not be reachable from the web (decisions 48, 51, spec 9a.7):
 *
 *   npm run admin -w @hg/api -- create-super-admin --email <e-mail> --name "<name>"
 *   npm run admin -w @hg/api -- replace-super-admin --email <e-mail> --name "<name>"
 *     (a new e-mail replaces the Super Admin; the current Super Admin's own e-mail re-onboards that same user)
 *   npm run admin -w @hg/api -- reset-2fa --email <e-mail>
 *   npm run admin -w @hg/api -- seal-order-tokens
 *     (seals the plain link tokens of orders placed before spec 9a.7 with ORDER_TOKEN_KEY; their links keep working;
 *     safe to run again; prints only a count)
 *   npm run admin -w @hg/api -- copy-media-to-s3 [--dry-run]
 *     (one-time copy of MEDIA_DIR/public and /private into the S3_* buckets; skips objects that exist, never
 *     deletes; prints counts and the keys that failed)
 *   node apps/api/dist/cli.js apply-db-grants
 *     (Phase 9b: run by the migrate service right after `prisma migrate deploy`, connected as the table owner; grants
 *     DB_APP_ROLE / DB_BACKUP_ROLE their privileges, skips a role that does not exist; safe to run again. It does not
 *     start the application, so it needs only DATABASE_URL)
 *
 * Inside the production image `npm run admin` does not work (`nest` is a dev dependency). Use:
 *   IMAGE_TAG=<tag> docker compose -f docker-compose.prod.yml --env-file <file> run --rm --no-deps api \
 *     node apps/api/dist/cli.js <command> [options]
 * (see deploy/README.md).
 *
 * Prints a one-time invite link for the new Super Admin. Run it on the server (or locally);
 * the e-mail is passed at runtime and never stored in the repository.
 */
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { AppModule } from './app.module.js';
import { AdminUsersService } from './auth/admin-users.service.js';
import { copyMediaToS3 } from './media/copy-media.js';
import { createStorage } from './media/media.module.js';
import { S3Storage } from './media/s3-storage.js';
import { OrderTokens, sealOrderTokens } from './orders/order-token.js';
import { PrismaService } from './prisma/prisma.service.js';
import { applyDbGrantsCli } from './system/db-grants.js';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: { email: { type: 'string' }, name: { type: 'string' }, 'dry-run': { type: 'boolean' } },
});

if (command === 'apply-db-grants') {
  // No application context: only DATABASE_URL is needed (in dev it comes from the .env files that importing
  // AppModule's ConfigModule.forRoot loads; it never overrides a variable already set).
  try {
    await applyDbGrantsCli(process.env);
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  }
} else {
  // The CLI never runs outbox jobs: that is the API's worker.
  process.env.OUTBOX_WORKER = 'off';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
  try {
    const users = app.get(AdminUsersService);
    if (command === 'create-super-admin' && values.email && values.name) {
      const link = await users.createSuperAdmin(values.email, values.name);
      console.log(`Super Admin created. Open this link within 7 days to choose a password:\n${link.url}`);
    } else if (command === 'replace-super-admin' && values.email && values.name) {
      const link = await users.replaceSuperAdmin(values.email, values.name);
      console.log(`Super Admin replaced. Open this link within 7 days to choose a password:\n${link.url}`);
    } else if (command === 'reset-2fa' && values.email) {
      await users.resetTwoFactorByEmail(values.email);
      console.log('2FA was reset. The user sets it up again at the next login.');
    } else if (command === 'seal-order-tokens') {
      const sealed = await sealOrderTokens(app.get(PrismaService), app.get(OrderTokens));
      console.log(`Sealed ${sealed} order token(s)`);
    } else if (command === 'copy-media-to-s3') {
      const config = app.get(ConfigService);
      const target = createStorage({
        get: ((key: string) => (key === 'STORAGE_PROVIDER' ? 's3' : config.get(key))) as never,
      });
      if (!(target instanceof S3Storage)) throw new Error('S3 storage is not configured');
      const dryRun = values['dry-run'] === true;
      const root = resolve(config.get<string>('MEDIA_DIR') || '../../storage');
      const { copied, skipped, failed } = await copyMediaToS3(root, target, { dryRun });
      console.log(
        `${dryRun ? 'Dry run: would copy' : 'Copied'} ${copied}, skipped ${skipped}, failed ${failed.length}`,
      );
      for (const key of failed) console.log(`FAILED ${key}`);
      if (failed.length) process.exitCode = 1;
    } else {
      console.error(
        'Usage:\n  create-super-admin --email <e-mail> --name "<name>"\n  replace-super-admin --email <e-mail> --name "<name>"\n  reset-2fa --email <e-mail>\n  seal-order-tokens\n  copy-media-to-s3 [--dry-run]\n  apply-db-grants',
      );
      process.exitCode = 1;
    }
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  } finally {
    await app.close();
  }
}
