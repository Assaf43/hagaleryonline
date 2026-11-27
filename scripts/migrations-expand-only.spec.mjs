import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(root, 'apps/api/prisma/migrations');
const ALLOWLIST = JSON.parse(readFileSync(join(root, 'scripts/migration-allowlist.json'), 'utf8'));

/**
 * Migrations stay expand-only (spec §6.3): a release may add things, never take away what the
 * previous release still reads. Each rule has a name that an allow-list entry refers to.
 * Matching runs over the whole cleaned text, including `$$ … $$` bodies (a DO block could hide a drop).
 */
const RULES = [
  { name: 'DROP TABLE', re: /\bDROP\s+TABLE\b/gi },
  { name: 'DROP COLUMN', re: /\bDROP\s+COLUMN\b/gi },
  { name: 'ALTER TYPE RENAME VALUE', re: /\bALTER\s+TYPE\b[^;]*?\bRENAME\s+VALUE\b/gi },
  { name: 'RENAME', re: /\bRENAME\s+(?!VALUE\b)/gi },
  { name: 'ALTER COLUMN TYPE', re: /\bALTER\s+COLUMN\s+(?:"[^"]+"|\w+)\s+(?:SET\s+DATA\s+)?TYPE\b/gi },
  { name: 'SET NOT NULL', re: /\bSET\s+NOT\s+NULL\b/gi },
  { name: 'DROP TYPE', re: /\bDROP\s+TYPE\b/gi },
  // Dropping a unique index widens, and a plain DROP INDEX is not a rule; only key constraints are reported.
  { name: 'DROP CONSTRAINT (fkey/pkey)', re: /\bDROP\s+CONSTRAINT\s+(?:IF\s+EXISTS\s+)?"?\w*_(?:fkey|pkey)\b/gi },
];

/** Blank comments and string literals but keep every newline, so line numbers stay true. */
function clean(sql) {
  const blank = (s) => s.replace(/[^\n]/g, ' ');
  return sql
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    .replace(/--[^\n]*/g, blank)
    .replace(/'(?:[^']|'')*'/g, blank);
}

function scan(sql) {
  const text = clean(sql);
  const hits = [];
  for (const { name, re } of RULES) {
    for (const m of text.matchAll(re)) {
      hits.push({ rule: name, line: text.slice(0, m.index).split('\n').length });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}

function violations(files, allowlist) {
  const out = [];
  for (const { migration, sql } of files) {
    for (const hit of scan(sql)) {
      if (allowlist.some((a) => a.migration === migration && a.pattern === hit.rule)) continue;
      out.push(
        `${migration}/migration.sql:${hit.line} breaks the rule "${hit.rule}". ` +
          `Migrations stay expand-only: see CLAUDE.md "Migrations stay expand-only" ` +
          `(split it over two releases, or add an allow-list entry with the two-release path as the reason).`,
      );
    }
  }
  return out;
}

const readTree = () =>
  readdirSync(MIGRATIONS, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(MIGRATIONS, d.name, 'migration.sql')))
    .map((d) => ({ migration: d.name, sql: readFileSync(join(MIGRATIONS, d.name, 'migration.sql'), 'utf8') }));

describe('expand-only migrations', () => {
  it('flags a DROP COLUMN in a new migration', () => {
    const v = violations([{ migration: '29990101000000_x', sql: 'SELECT 1;\nALTER TABLE "a" DROP COLUMN "b";' }], []);
    expect(v).toHaveLength(1);
    expect(v[0]).toContain('29990101000000_x/migration.sql:2');
    expect(v[0]).toContain('DROP COLUMN');
    expect(v[0]).toContain('Migrations stay expand-only');
  });

  it('flags each contracting rule', () => {
    const cases = {
      'DROP TABLE': 'DROP TABLE "a";',
      RENAME: 'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
      'ALTER TYPE RENAME VALUE': "ALTER TYPE \"t\" RENAME VALUE 'x' TO 'y';",
      'ALTER COLUMN TYPE': 'ALTER TABLE "a" ALTER COLUMN "b" TYPE INTEGER;',
      'SET NOT NULL': 'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
      'DROP TYPE': 'DROP TYPE "t";',
      'DROP CONSTRAINT (fkey/pkey)': 'ALTER TABLE "a" DROP CONSTRAINT "a_b_fkey";',
    };
    for (const [rule, sql] of Object.entries(cases)) {
      expect(
        scan(sql).map((h) => h.rule),
        sql,
      ).toContain(rule);
    }
  });

  it('allows what widens or is not a rule', () => {
    const sql = [
      'DROP INDEX "a_b_key";',
      'ALTER TABLE "a" DROP CONSTRAINT "a_b_check";',
      'ALTER TABLE "a" ALTER COLUMN "b" DROP NOT NULL;',
      'ALTER TABLE "a" ADD COLUMN "c" TEXT;',
    ].join('\n');
    expect(scan(sql)).toEqual([]);
  });

  it('allows an allow-listed one', () => {
    const files = [{ migration: '29990101000000_x', sql: 'ALTER TABLE "a" DROP COLUMN "b";' }];
    const allow = [{ migration: '29990101000000_x', pattern: 'DROP COLUMN', reason: 'test' }];
    expect(violations(files, allow)).toEqual([]);
    expect(violations(files, [{ ...allow[0], migration: 'other' }])).toHaveLength(1);
  });

  it('ignores comments and string literals', () => {
    const sql = [
      '-- ALTER TABLE "a" DROP COLUMN "b";',
      '/* DROP TABLE "a";',
      'RENAME */',
      'COMMENT ON TABLE "a" IS \'we DROP TABLE nothing; RENAME nothing\';',
      'SELECT 1;',
    ].join('\n');
    expect(scan(sql)).toEqual([]);
  });

  it('keeps line numbers across block comments', () => {
    expect(scan('/* a\nb\nc */\nDROP TABLE "a";')).toEqual([{ rule: 'DROP TABLE', line: 4 }]);
  });

  it('scans inside $$ bodies', () => {
    expect(scan('DO $$ BEGIN\nDROP TABLE "a";\nEND $$;').map((h) => h.rule)).toEqual(['DROP TABLE']);
  });

  it('allow-list entries are real, reasoned and not stale', () => {
    const tree = readTree();
    for (const a of ALLOWLIST) {
      expect(a.reason?.trim(), JSON.stringify(a)).toBeTruthy();
      const m = tree.find((t) => t.migration === a.migration);
      expect(m, `unknown migration ${a.migration}`).toBeTruthy();
      expect(
        scan(m.sql).map((h) => h.rule),
        `stale entry ${JSON.stringify(a)}`,
      ).toContain(a.pattern);
    }
  });

  it('current tree passes', () => {
    expect(violations(readTree(), ALLOWLIST)).toEqual([]);
  });
});
