import { assertRoleName } from './db-grants.js';

describe('assertRoleName (Phase 9b)', () => {
  it('accepts lower-case PostgreSQL identifiers up to 63 characters', () => {
    for (const name of ['nesto_app', 'nesto_backup', '_x', 'a1', 'a'.repeat(63)]) {
      expect(() => assertRoleName(name), name).not.toThrow();
    }
  });

  it('refuses anything else, so nothing but a plain identifier reaches the SQL', () => {
    for (const name of ['', 'Nesto', '1app', 'a-b', 'a b', 'a"b', 'a;drop', 'a'.repeat(64), 'nesto_app\n']) {
      expect(() => assertRoleName(name), JSON.stringify(name)).toThrow(/invalid DB role name/);
    }
  });
});
