/**
 * Server CLI for what must not be reachable from the web (decisions 48, 51):
 *
 *   npm run admin -w @hg/api -- create-super-admin --email <e-mail> --name "<name>"
 *   npm run admin -w @hg/api -- reset-2fa --email <e-mail>
 *
 * Prints a one-time invite link for the new Super Admin. Run it on the server (or locally);
 * the e-mail is passed at runtime and never stored in the repository.
 */
import { NestFactory } from '@nestjs/core';
import { parseArgs } from 'node:util';
import { AppModule } from './app.module.js';
import { AdminUsersService } from './auth/admin-users.service.js';

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { email: { type: 'string' }, name: { type: 'string' } } });

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['error', 'warn'] });
try {
  const users = app.get(AdminUsersService);
  if (command === 'create-super-admin' && values.email && values.name) {
    const link = await users.createSuperAdmin(values.email, values.name);
    console.log(`Super Admin created. Open this link within 7 days to choose a password:\n${link.url}`);
  } else if (command === 'reset-2fa' && values.email) {
    await users.resetTwoFactorByEmail(values.email);
    console.log('2FA was reset. The user sets it up again at the next login.');
  } else {
    console.error('Usage:\n  create-super-admin --email <e-mail> --name "<name>"\n  reset-2fa --email <e-mail>');
    process.exitCode = 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
} finally {
  await app.close();
}
