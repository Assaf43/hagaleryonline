import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * OWASP A03 (spec 9a.2): raw SQL in the API goes only through Prisma's tagged templates (`$queryRaw\`…\``,
 * `Prisma.sql`), which send every value as a bind parameter. The string-built forms are banned.
 */
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const API_SRC = join(root, 'apps', 'api', 'src');
const SKIP = new Set(['generated', 'node_modules', 'dist']);
const UNSAFE = /RawUnsafe|Prisma\.raw\b/;

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.[cm]?[jt]s$/.test(name)) out.push(full);
  }
  return out;
}

/** `file:line` of every unsafe raw-SQL call in the given files. */
export function findUnsafeSql(files) {
  const offenders = [];
  for (const [file, text] of files)
    text.split('\n').forEach((line, i) => {
      if (UNSAFE.test(line)) offenders.push(`${file}:${i + 1}`);
    });
  return offenders;
}

describe('no unsafe raw SQL in the API', () => {
  it('the check catches each banned form', () => {
    const sample = [
      ['a.ts', 'await db.$queryRawUnsafe(`SELECT ${x}`);'],
      ['b.ts', 'ok\nawait tx.$executeRawUnsafe(sql);'],
      ['c.ts', 'const part = Prisma.raw(column);'],
      ['d.ts', 'await db.$queryRaw`SELECT ${x}`; const s = Prisma.sql`a = ${b}`;'],
      ['e.ts', 'const run = db.queryRawUnsafe;'],
      ['f.ts', 'const raw = Prisma.raw;'],
      ['g.ts', 'const rawText = Prisma.rawText; // a different name'],
    ];
    expect(findUnsafeSql(sample)).toEqual(['a.ts:1', 'b.ts:2', 'c.ts:1', 'e.ts:1', 'f.ts:1']);
  });

  it('apps/api/src (outside generated/) uses no *RawUnsafe call and no Prisma.raw', () => {
    const files = walk(API_SRC).map((file) => [relative(root, file).split(sep).join('/'), readFileSync(file, 'utf8')]);
    expect(files.length).toBeGreaterThan(50);
    expect(findUnsafeSql(files)).toEqual([]);
  });
});
