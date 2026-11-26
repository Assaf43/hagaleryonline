import { randomBytes } from 'node:crypto';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from './../src/generated/prisma/client.js';
import { applyDbGrants } from './../src/system/db-grants.js';

/**
 * Phase 9b (HANDOFF 9b, NFR-12): the app and the backup job connect with roles that do not own the tables. The
 * e2e connection is the cluster superuser (the table owner here), so the test roles are NOLOGIN and every check
 * "as" a role runs after `SET LOCAL ROLE` inside a transaction that is rolled back: a superuser that sets a
 * non-superuser role is checked with that role's privileges only (the negative control below proves it).
 * Roles are cluster-wide: each run uses fresh random names and drops them (and their grants) in `afterAll`.
 */
describe('DB grants (e2e, Phase 9b)', () => {
  const suffix = randomBytes(4).toString('hex');
  const roles = { app: `hg_test_app_${suffix}`, backup: `hg_test_backup_${suffix}` };
  let prisma: PrismaClient;
  let db: pg.Client;

  /** Runs `body` as `role` in a transaction that is always rolled back; returns the error message or 'ok'. */
  async function as(role: string, ...statements: string[]): Promise<string> {
    await db.query('BEGIN');
    try {
      await db.query(`SET LOCAL ROLE "${role}"`);
      for (const sql of statements) await db.query(sql);
      return 'ok';
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      await db.query('ROLLBACK');
    }
  }

  async function privileges(role: string): Promise<Record<string, string[]>> {
    const kinds = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'];
    const { rows } = await db.query<{ tablename: string; granted: string[] }>(
      `SELECT t.tablename,
              ARRAY(SELECT k FROM unnest($2::text[]) k
                    WHERE has_table_privilege($1, format('public.%I', t.tablename), k)) AS granted
         FROM pg_tables t WHERE t.schemaname = 'public' ORDER BY t.tablename`,
      [role, kinds],
    );
    return Object.fromEntries(rows.map((r) => [r.tablename, r.granted]));
  }

  async function aclSnapshot(): Promise<unknown[]> {
    const { rows } = await db.query(
      `SELECT c.relname, c.relkind, a.privilege_type, a.is_grantable
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN LATERAL aclexplode(c.relacl) a
         JOIN pg_roles r ON r.oid = a.grantee
        WHERE n.nspname = 'public' AND r.rolname = ANY($1)
        ORDER BY 1, 2, 3`,
      [[roles.app, roles.backup]],
    );
    return rows;
  }

  beforeAll(async () => {
    const url = process.env.DATABASE_URL ?? '';
    if (!new URL(url).pathname.endsWith('_test')) throw new Error('db-grants e2e runs only on the _test database');
    db = new pg.Client({ connectionString: url });
    await db.connect();
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
    await db.query(`CREATE ROLE "${roles.app}" NOLOGIN`);
    await db.query(`CREATE ROLE "${roles.backup}" NOLOGIN`);
  });

  afterAll(async () => {
    // A failed beforeAll must show its own error, not a TypeError from here.
    if (!db) return;
    for (const role of [roles.app, roles.backup]) {
      const { rowCount } = await db.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]).catch(() => ({
        rowCount: 0,
      }));
      if (!rowCount) continue;
      // DROP OWNED also revokes the role's privileges on this database and on shared objects (CONNECT).
      await db.query(`DROP OWNED BY "${role}"`);
      await db.query(`DROP ROLE "${role}"`);
    }
    await prisma?.$disconnect();
    await db.end();
  });

  it('a role without grants is refused (negative control: SET ROLE drops the superuser rights)', async () => {
    expect(await as(roles.app, 'SELECT 1 FROM orders LIMIT 1')).toMatch(/permission denied/);
    expect(await as(roles.backup, 'SELECT 1 FROM orders LIMIT 1')).toMatch(/permission denied/);
  });

  it('every table has app DML except the listed ones', async () => {
    const ran = await applyDbGrants(prisma, roles, () => undefined);
    expect(ran.length).toBeGreaterThan(0);
    const granted = await privileges(roles.app);
    expect(Object.keys(granted).length).toBeGreaterThan(30);
    for (const [table, list] of Object.entries(granted)) {
      const expected =
        table === 'marketing_consent_events'
          ? ['SELECT', 'INSERT']
          : table === '_prisma_migrations'
            ? ['SELECT']
            : ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
      expect(list, table).toEqual(expected);
    }
  });

  it('as the app role: consent history cannot be changed even with the erase flag, TRUNCATE is denied, INSERT works', async () => {
    const contact = `INSERT INTO marketing_contacts (id, email, status, source, unsubscribe_token_hash, updated_at)
      VALUES ('00000000-0000-4000-8000-${suffix}0000', 'grants-${suffix}@e2e.test', 'pending', 'newsletter',
              'grants-${suffix}', now())`;
    // The contact is written by the owner first (inside the same rolled-back transaction), then the role is set.
    await db.query('BEGIN');
    try {
      await db.query(contact);
      await db.query(`SET LOCAL ROLE "${roles.app}"`);
      await db.query(
        `INSERT INTO marketing_consent_events (contact_id, action, source)
         VALUES ('00000000-0000-4000-8000-${suffix}0000', 'requested', 'newsletter')`,
      );
      const { rows } = await db.query('SELECT count(*)::int AS n FROM marketing_consent_events WHERE contact_id = $1', [
        `00000000-0000-4000-8000-${suffix}0000`,
      ]);
      expect(rows[0].n).toBe(1);
    } finally {
      await db.query('ROLLBACK');
    }

    const flag = `SET LOCAL hg.consent_erase = 'on'`;
    expect(await as(roles.app, flag, 'UPDATE marketing_consent_events SET ip = ip WHERE false')).toMatch(
      /permission denied for table marketing_consent_events/,
    );
    expect(await as(roles.app, flag, 'DELETE FROM marketing_consent_events WHERE false')).toMatch(
      /permission denied for table marketing_consent_events/,
    );
    expect(await as(roles.app, 'TRUNCATE marketing_consent_events')).toMatch(/permission denied/);
    expect(await as(roles.app, 'TRUNCATE orders CASCADE')).toMatch(/permission denied/);
    expect(await as(roles.app, 'DROP TRIGGER marketing_consent_events_no_change ON marketing_consent_events')).toMatch(
      /must be owner/,
    );
    expect(await as(roles.app, 'DELETE FROM _prisma_migrations WHERE false')).toMatch(/permission denied/);
    expect(await as(roles.app, 'SELECT count(*) FROM _prisma_migrations')).toBe('ok');
    // What the app does today keeps working: DML, sequences, the home-page save lock.
    expect(await as(roles.app, 'UPDATE orders SET id = id WHERE false', 'DELETE FROM carts WHERE false')).toBe('ok');
    expect(await as(roles.app, `SELECT nextval('mock_invoice_seq')`)).toBe('ok');
    expect(await as(roles.app, 'LOCK TABLE home_sections IN EXCLUSIVE MODE')).toBe('ok');
  });

  it('as the backup role: SELECT works, writes are denied except its own run rows', async () => {
    expect(await as(roles.backup, 'SELECT count(*) FROM orders', 'SELECT count(*) FROM _prisma_migrations')).toBe('ok');
    expect(await as(roles.backup, 'INSERT INTO orders DEFAULT VALUES')).toMatch(/permission denied for table orders/);
    expect(await as(roles.backup, 'UPDATE orders SET id = id WHERE false')).toMatch(/permission denied/);
    expect(await as(roles.backup, 'DELETE FROM backup_runs WHERE false')).toMatch(/permission denied/);
    expect(await as(roles.backup, 'TRUNCATE backup_runs')).toMatch(/permission denied/);
    expect(
      await as(
        roles.backup,
        `INSERT INTO backup_runs (kind, started_at) VALUES ('db', now())`,
        `UPDATE backup_runs SET ok = true, bytes = 1, objects = 1, finished_at = now(), detail = 'e2e'
          WHERE id = currval(pg_get_serial_sequence('backup_runs', 'id'))`,
      ),
    ).toBe('ok');
    const granted = await privileges(roles.backup);
    for (const [table, list] of Object.entries(granted)) {
      expect(list, table).toEqual(table === 'backup_runs' ? ['SELECT', 'INSERT', 'UPDATE'] : ['SELECT']);
    }
  });

  it('second run is a no-op that still succeeds', async () => {
    const before = await aclSnapshot();
    const first = await applyDbGrants(prisma, roles, () => undefined);
    const second = await applyDbGrants(prisma, roles, () => undefined);
    expect(second).toEqual(first);
    expect(await aclSnapshot()).toEqual(before);
  });

  it('missing roles are skipped', async () => {
    const lines: string[] = [];
    const missing = { app: `hg_test_none_${suffix}`, backup: `hg_test_nobk_${suffix}` };
    expect(await applyDbGrants(prisma, missing, (line) => lines.push(line))).toEqual([]);
    expect(lines).toEqual([
      `DB role ${missing.app} does not exist: grants skipped`,
      `DB role ${missing.backup} does not exist: grants skipped`,
    ]);
  });

  it('refuses a bad role name, the same role twice, and the connected owner', async () => {
    await expect(applyDbGrants(prisma, { app: 'x"; DROP TABLE orders; --', backup: roles.backup })).rejects.toThrow(
      /invalid DB role name/,
    );
    await expect(applyDbGrants(prisma, { app: roles.app, backup: roles.app })).rejects.toThrow(/must differ/);
    const { rows } = await db.query<{ u: string }>('SELECT current_user AS u');
    await expect(applyDbGrants(prisma, { app: rows[0].u, backup: roles.backup })).rejects.toThrow(/owner/);
  });
});
