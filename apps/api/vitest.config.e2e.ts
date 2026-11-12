import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config({ path: '../../.env', quiet: true });

/** e2e tests run against their own database (<db>_test), never the dev data or the real Super Admin. */
const devUrl = new URL(process.env.DATABASE_URL ?? 'postgresql://hagalery:hagalery_dev@localhost:5432/hagalery');
const testUrl = new URL(devUrl);
testUrl.pathname = `${devUrl.pathname}_test`;

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    globalSetup: ['./test/e2e-global-setup.ts'],
    // One database: run the files one after another.
    fileParallelism: false,
    env: {
      DATABASE_URL: testUrl.toString(),
      TOTP_ENCRYPTION_KEY: process.env.TOTP_ENCRYPTION_KEY || Buffer.alloc(32, 7).toString('base64'),
      ADMIN_URL: 'http://localhost:4300',
      STOREFRONT_URL: 'http://localhost:4200',
      COOKIE_SECURE: 'false',
      // The suite logs in many times from one IP; the per-IP limit has its own unit test.
      AUTH_IP_ATTEMPT_LIMIT: '1000',
      // Uploaded test photos go to a temp folder, never to the dev storage.
      MEDIA_DIR: join(tmpdir(), 'hagalery-e2e-media'),
      // Sandbox payments (Phase 4c): the tests sign webhooks themselves with this secret.
      // Public-write throttles (checkout, retry, sandbox, coupon) relaxed; the 429 tests lower one themselves.
      THROTTLE_CHECKOUT_LIMIT: '100000',
      THROTTLE_RETRY_LIMIT: '100000',
      THROTTLE_SANDBOX_LIMIT: '100000',
      THROTTLE_COUPON_LIMIT: '100000',
      THROTTLE_CANCEL_LIMIT: '100000',
      THROTTLE_DELIVERY_LIMIT: '100000',
      PAYMENT_PROVIDER: 'sandbox',
      // Notifications (Phase 5b): the mock adapters send nothing and log the full message.
      EMAIL_PROVIDER: 'mock',
      SMS_PROVIDER: 'mock',
      EMAIL_FROM: 'NESTO <no-reply@example.test>',
      // Invoices (Phase 5b): the mock numbers documents MOCK-INV-… / MOCK-CN-… and keeps them under MEDIA_DIR/private.
      INVOICE_PROVIDER: 'mock',
      PAYMENT_SANDBOX_SECRET: 'e2e-sandbox-secret-not-for-production',
      // Outbox (Phase 5b): no background worker; the tests call OutboxService.runDue() themselves.
      OUTBOX_WORKER: 'off',
    },
  },
});
