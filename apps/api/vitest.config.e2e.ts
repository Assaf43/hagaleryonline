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
      COOKIE_SECURE: 'false',
      // The suite logs in many times from one IP; the per-IP limit has its own unit test.
      AUTH_IP_ATTEMPT_LIMIT: '1000',
    },
  },
});
