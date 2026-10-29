import { execSync } from 'node:child_process';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

/**
 * Before the e2e run: create the test database if needed, apply migrations, refill the catalog seed
 * and remove admin users left by an earlier run.
 */
export default async function setup(project: TestProject) {
  const url = new URL(project.config.env.DATABASE_URL ?? '');
  const database = url.pathname.slice(1);
  if (!database.endsWith('_test')) throw new Error(`Refusing to prepare a non-test database: ${database}`);

  const admin = new URL(url);
  admin.pathname = '/postgres';
  const client = new pg.Client({ connectionString: admin.toString() });
  await client.connect();
  try {
    const { rowCount } = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [database]);
    if (!rowCount) await client.query(`CREATE DATABASE "${database}"`);
  } finally {
    await client.end();
  }

  const env = { ...process.env, DATABASE_URL: url.toString() };
  execSync('npx prisma migrate deploy', { env, stdio: 'pipe' });
  execSync('npx tsx prisma/seed.ts', { env, stdio: 'pipe' });

  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  try {
    await db.query('TRUNCATE admin_users, audit_log RESTART IDENTITY CASCADE');
  } finally {
    await db.end();
  }
}
