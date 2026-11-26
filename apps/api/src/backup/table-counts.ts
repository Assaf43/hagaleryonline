/**
 * Row counts of every table in `public` (spec 9b.5): taken in the dump's snapshot and compared, table by table, after
 * a restore. Table names come from the catalog and are quoted as identifiers; the label is a bound parameter.
 */

export interface Queryable {
  query(sql: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

export type TableCounts = Record<string, number>;

/** A PostgreSQL identifier in double quotes (inner quotes doubled). */
export function quoteIdent(name: string): string {
  if (name === '' || name.includes('\u0000')) throw new Error('bad identifier');
  return `"${name.replace(/"/g, '""')}"`;
}

/** One query: `SELECT $n::text AS name, count(*) FROM public."<table>"`, joined with UNION ALL. */
export function countsSql(tables: string[]): string {
  if (tables.length === 0) return 'SELECT NULL::text AS name, 0::bigint AS n WHERE false';
  return tables
    .map((table, i) => `SELECT $${i + 1}::text AS name, count(*)::bigint AS n FROM public.${quoteIdent(table)}`)
    .join('\nUNION ALL\n');
}

const LIST_TABLES = `SELECT tablename AS name FROM pg_catalog.pg_tables WHERE schemaname = 'public' ORDER BY tablename COLLATE "C"`;

/** Every table in `public` with its row count, sorted by name. Runs inside the caller's transaction / snapshot. */
export async function tableCounts(db: Queryable): Promise<TableCounts> {
  const tables = ((await db.query(LIST_TABLES)).rows as { name: string }[]).map((r) => r.name);
  const { rows } = await db.query(countsSql(tables), tables);
  const counts = new Map((rows as { name: string; n: string | number }[]).map((r) => [r.name, Number(r.n)]));
  return Object.fromEntries(tables.map((table) => [table, counts.get(table) ?? 0]));
}

/** Each table whose count differs, plus missing and extra tables, sorted by name. Empty = exact match. */
export function compareCounts(expected: TableCounts, actual: TableCounts): string[] {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort();
  const out: string[] = [];
  for (const name of names) {
    const want = expected[name];
    const got = actual[name];
    if (want === undefined) out.push(`${name}: not expected, got ${got}`);
    else if (got === undefined) out.push(`${name}: expected ${want}, missing`);
    else if (want !== got) out.push(`${name}: expected ${want}, got ${got}`);
  }
  return out;
}
