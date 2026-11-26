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

/** Lower-case PostgreSQL identifiers only; PostgreSQL quotes them too (`%I`) and they are only bound parameters. */
const ROLE_NAME = /^[a-z_][a-z0-9_]{0,62}$/;

export interface DbRoles {
  app: string;
  backup: string;
}

export function assertRoleName(name: string): void {
  if (!ROLE_NAME.test(name)) throw new Error(`invalid DB role name: ${JSON.stringify(name).slice(0, 80)}`);
}

/*
 * Statement templates for PostgreSQL's `format()`: `%1$I` = the role, `%2$I` = the current database, `%3$s` = the
 * `backup_runs` id sequence as a regclass (already quoted by PostgreSQL). They are constants of this module; the role
 * name is only ever a bound parameter and PostgreSQL itself quotes it with `%I` (no string-built SQL, spec 9a.2).
 */

/** The app: DML on every table, sequences, functions; consent history insert-only; migrations history read-only. */
const APP_TEMPLATES = [
  'GRANT CONNECT ON DATABASE %2$I TO %1$I',
  'GRANT USAGE ON SCHEMA public TO %1$I',
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %1$I',
  'REVOKE TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %1$I',
  'GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO %1$I',
  'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO %1$I',
  'REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.marketing_consent_events FROM %1$I',
  'REVOKE ALL ON TABLE public._prisma_migrations FROM %1$I',
  'GRANT SELECT ON TABLE public._prisma_migrations TO %1$I',
] as const;

/** The backup job: reads everything; writes only its own `backup_runs` rows (insert, then update when done). */
const BACKUP_TEMPLATES = [
  'GRANT CONNECT ON DATABASE %2$I TO %1$I',
  'GRANT USAGE ON SCHEMA public TO %1$I',
  'GRANT SELECT ON ALL TABLES IN SCHEMA public TO %1$I',
  'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON ALL TABLES IN SCHEMA public FROM %1$I',
  'GRANT SELECT ON ALL SEQUENCES IN SCHEMA public TO %1$I',
  'REVOKE USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA public FROM %1$I',
  'GRANT INSERT, UPDATE ON TABLE public.backup_runs TO %1$I',
] as const;
const BACKUP_SEQUENCE_TEMPLATE = 'GRANT USAGE, SELECT ON SEQUENCE %3$s TO %1$I';

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

      const [seq] = await tx.$queryRaw<{ exists: boolean }[]>`
      SELECT pg_get_serial_sequence('public.backup_runs', 'id') IS NOT NULL AS "exists"`;

      const ran: string[] = [];
      for (const [role, templates] of [
        [roles.app, APP_TEMPLATES],
        [roles.backup, seq?.exists ? [...BACKUP_TEMPLATES, BACKUP_SEQUENCE_TEMPLATE] : BACKUP_TEMPLATES],
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
        for (const template of templates) {
          // PostgreSQL builds the statement from the constant template and the bound role name (quoted by %I), keeps
          // it in a transaction-local setting, and a parameterless DO block runs it.
          const [built] = await tx.$queryRaw<{ statement: string }[]>`
          SELECT set_config('hg.grant_statement',
                            format(${template}::text, ${role}::text, current_database(),
                                   pg_get_serial_sequence('public.backup_runs', 'id')::regclass::text),
                            true) AS statement`;
          await tx.$executeRaw`DO $$ BEGIN EXECUTE current_setting('hg.grant_statement'); END $$`;
          ran.push(built.statement);
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
