import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client.js';

/**
 * Database roles (Phase 9b, HANDOFF 9b): the tables are owned by the migrate role (`nesto_owner`); the API connects
 * as `nesto_app` and the backup job as `nesto_backup`, neither of which owns anything. A role that does not own
 * `marketing_consent_events` cannot drop its append-only trigger, and without UPDATE / DELETE on it the erase flag
 * (`hg.consent_erase`, any role may set it) changes nothing: the consent history stays append-only for the app.
 *
 * `applyDbGrants` runs as the owner after every `prisma migrate deploy` (CLI `apply-db-grants`), so tables added by
 * a migration are covered before the new API starts. It is idempotent: the same statements in one transaction,
 * revokes before grants, so the privileges always end up exactly as listed below whatever they were before.
 */

/** Lower-case PostgreSQL identifiers only: they are quoted too, but nothing else is ever put into the SQL. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface DbRoles {
  app: string;
  backup: string;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

export function assertRoleName(name: string): void {
  if (!ROLE_NAME.test(name)) throw new Error(`invalid DB role name: ${JSON.stringify(name).slice(0, 80)}`);
}

/** The app: DML on every table, sequences, functions; consent history insert-only; migrations history read-only. */
function appStatements(role: string, database: string): string[] {
  const r = quote(role);
  return [
    `GRANT CONNECT ON DATABASE ${quote(database)} TO ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${r}`,
    `REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${r}`,
    `GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
    `GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO ${r}`,
    `REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.marketing_consent_events FROM ${r}`,
    `REVOKE ALL ON TABLE public._prisma_migrations FROM ${r}`,
    `GRANT SELECT ON TABLE public._prisma_migrations TO ${r}`,
  ];
}

/** The backup job: reads everything; writes only its own `backup_runs` rows (insert, then update when done). */
function backupStatements(role: string, database: string, backupRunsSeq: string | null): string[] {
  const r = quote(role);
  return [
    `GRANT CONNECT ON DATABASE ${quote(database)} TO ${r}`,
    `GRANT USAGE ON SCHEMA public TO ${r}`,
    `GRANT SELECT ON ALL TABLES IN SCHEMA public TO ${r}`,
    `REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM ${r}`,
    `GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO ${r}`,
    `REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM ${r}`,
    `GRANT INSERT, UPDATE ON TABLE public.backup_runs TO ${r}`,
    ...(backupRunsSeq ? [`GRANT USAGE, SELECT ON SEQUENCE ${backupRunsSeq} TO ${r}`] : []),
  ];
}

/**
 * Grants the app and backup roles their privileges; returns the statements it ran. A role that does not exist is
 * skipped with a log line (the dev database has none). Refuses unless the connection owns the tables, and refuses a
 * target role that is the owner (or a member of it) or a superuser: revoking from it would be meaningless or harmful.
 */
export async function applyDbGrants(
  prisma: PrismaClient,
  roles: DbRoles,
  log: (line: string) => void = (line) => console.log(line),
): Promise<string[]> {
  assertRoleName(roles.app);
  assertRoleName(roles.backup);
  if (roles.app === roles.backup) throw new Error('DB_APP_ROLE and DB_BACKUP_ROLE must differ');

  return prisma.$transaction(
    async (tx) => {
      const [ctx] = await tx.$queryRaw<{ database: string; owner: string | null; isOwner: boolean | null }[]>`
      SELECT current_database() AS database,
             (SELECT rolname FROM pg_roles WHERE oid = c.relowner) AS owner,
             pg_has_role(current_user, c.relowner, 'MEMBER') AS "isOwner"
        FROM (SELECT to_regclass('public._prisma_migrations') AS oid) t
        LEFT JOIN pg_class c ON c.oid = t.oid`;
      if (!ctx.owner) throw new Error('no _prisma_migrations table: run prisma migrate deploy first');
      if (!ctx.isOwner) throw new Error('apply-db-grants must run as the owner of the tables (MIGRATE_DATABASE_URL)');

      const [seq] = await tx.$queryRaw<{ name: string | null }[]>`
      SELECT format('%I.%I', n.nspname, s.relname) AS name
        FROM pg_class s JOIN pg_namespace n ON n.oid = s.relnamespace
       WHERE s.oid = pg_get_serial_sequence('public.backup_runs', 'id')::regclass`;

      const ran: string[] = [];
      for (const [role, statements] of [
        [roles.app, appStatements(roles.app, ctx.database)],
        [roles.backup, backupStatements(roles.backup, ctx.database, seq?.name ?? null)],
      ] as const) {
        const [found] = await tx.$queryRaw<{ privileged: boolean }[]>`
        SELECT r.rolsuper OR pg_has_role(r.oid, c.relowner, 'MEMBER') AS privileged
          FROM pg_roles r, pg_class c
         WHERE r.rolname = ${role} AND c.oid = 'public._prisma_migrations'::regclass`;
        if (!found) {
          log(`DB role ${role} does not exist: grants skipped`);
          continue;
        }
        if (found.privileged) throw new Error(`DB role ${role} is a superuser or the table owner: refusing to grant`);
        for (const sql of statements) {
          await tx.$executeRawUnsafe(sql);
          ran.push(sql);
        }
      }
      return ran;
    },
    // GRANT / REVOKE may wait on locks held by the API that is still running while migrate runs.
    { timeout: 60_000, maxWait: 10_000 },
  );
}

/** CLI `apply-db-grants`: connects with DATABASE_URL (the migrate service sets it to the owner's URL). */
export async function applyDbGrantsCli(env: NodeJS.ProcessEnv): Promise<void> {
  const url = env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is not set');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }), errorFormat: 'minimal' });
  try {
    const ran = await applyDbGrants(prisma, {
      app: env.DB_APP_ROLE || 'nesto_app',
      backup: env.DB_BACKUP_ROLE || 'nesto_backup',
    });
    console.log(`DB grants applied: ${ran.length} statement(s)`);
  } finally {
    await prisma.$disconnect();
  }
}
