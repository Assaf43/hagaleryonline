import {
  createDatabaseSql,
  FOREIGN_OWNED_SQL,
  OWNER_ROLE_SQL,
  ownerSetupSql,
  restoreDb,
  restoreOwner,
} from './restore.js';

const OBJECT = 'db/2026-11-26/nesto-2026-11-26T00:30:00.123Z.dump.age';

describe('restoreOwner (restore-db --owner)', () => {
  it('defaults to DB_OWNER_ROLE, else nesto_owner; the option wins', () => {
    expect(restoreOwner({})).toBe('nesto_owner');
    expect(restoreOwner({ DB_OWNER_ROLE: '' })).toBe('nesto_owner');
    expect(restoreOwner({ DB_OWNER_ROLE: 'other_owner' })).toBe('other_owner');
    expect(restoreOwner({ DB_OWNER_ROLE: 'other_owner' }, 'hg_test_owner_ab12')).toBe('hg_test_owner_ab12');
  });

  it('none (option or env) keeps the restore admin as the owner', () => {
    expect(restoreOwner({}, 'none')).toBeNull();
    expect(restoreOwner({ DB_OWNER_ROLE: 'none' })).toBeNull();
  });

  it('refuses a name outside the db-grants.ts rule', () => {
    for (const bad of ['Nesto_Owner', 'owner; DROP DATABASE nesto', 'a b', '"x"', '', '9owner', 'a'.repeat(64)])
      expect(() => restoreOwner({}, bad), bad).toThrow('role name must match');
    expect(() => restoreOwner({ DB_OWNER_ROLE: 'Bad-Role' })).toThrow('role name must match');
  });

  it('a bad owner is refused before anything is read or connected', async () => {
    await expect(
      restoreDb({}, { object: OBJECT, identity: '/nonexistent', targetDb: 'nesto_restored', owner: 'Bad Role' }),
    ).rejects.toThrow('role name must match');
  });
});

describe('restore SQL builders', () => {
  it('CREATE DATABASE with a quoted OWNER, or without one', () => {
    expect(createDatabaseSql('nesto_restored', 'nesto_owner')).toBe(
      'CREATE DATABASE "nesto_restored" OWNER "nesto_owner"',
    );
    expect(createDatabaseSql('nesto_restore_check', null)).toBe('CREATE DATABASE "nesto_restore_check"');
  });

  it('CREATE DATABASE refuses a bad database or role name', () => {
    expect(() => createDatabaseSql('nesto"; DROP', 'nesto_owner')).toThrow('database name must match');
    expect(() => createDatabaseSql('nesto_restored', 'x" SUPERUSER')).toThrow('role name must match');
  });

  it('owner setup: nothing for PUBLIC on the database, schema public given to the owner (as 01-roles.sh)', () => {
    expect(ownerSetupSql('nesto_restored', 'nesto_owner')).toEqual({
      cluster: ['REVOKE ALL ON DATABASE "nesto_restored" FROM PUBLIC'],
      inTarget: ['ALTER SCHEMA public OWNER TO "nesto_owner"', 'REVOKE ALL ON SCHEMA public FROM PUBLIC'],
    });
    expect(() => ownerSetupSql('nesto_restored', 'Owner')).toThrow('role name must match');
  });

  it('the role and ownership checks take the role only as a bound parameter', () => {
    for (const sql of [OWNER_ROLE_SQL, FOREIGN_OWNED_SQL]) {
      expect(sql).toContain('$1');
      expect(sql).not.toContain('nesto_owner');
    }
    expect(OWNER_ROLE_SQL).toContain(`pg_has_role(current_user, r.oid, 'SET')`);
    // Extension members (pg_trgm's functions, owned by the bootstrap superuser) are not counted.
    expect(FOREIGN_OWNED_SQL).toContain(`deptype = 'e'`);
  });
});
