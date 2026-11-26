import { compareCounts, countsSql, quoteIdent, tableCounts } from './table-counts.js';

describe('quoteIdent', () => {
  it('double-quotes a name and doubles inner quotes', () => {
    expect(quoteIdent('orders')).toBe('"orders"');
    expect(quoteIdent('Mixed Case')).toBe('"Mixed Case"');
    expect(quoteIdent('a"; DROP TABLE x; --')).toBe('"a""; DROP TABLE x; --"');
  });

  it('refuses an empty name or a NUL', () => {
    expect(() => quoteIdent('')).toThrow();
    expect(() => quoteIdent('a\u0000b')).toThrow();
  });
});

describe('countsSql', () => {
  it('counts each table under a quoted identifier; the name label is a bound parameter', () => {
    expect(countsSql(['orders', 'we"ird'])).toBe(
      'SELECT $1::text AS name, count(*)::bigint AS n FROM public."orders"\n' +
        'UNION ALL\n' +
        'SELECT $2::text AS name, count(*)::bigint AS n FROM public."we""ird"',
    );
  });

  it('an empty list gives a query with no rows', () => {
    expect(countsSql([])).toBe('SELECT NULL::text AS name, 0::bigint AS n WHERE false');
  });
});

describe('tableCounts', () => {
  it('lists the public tables, then counts them in one query with the names as parameters', async () => {
    const calls: { sql: string; values?: unknown[] }[] = [];
    const db = {
      query: (sql: string, values?: unknown[]) => {
        calls.push({ sql, values });
        if (calls.length === 1) return Promise.resolve({ rows: [{ name: 'a' }, { name: 'b' }] });
        return Promise.resolve({
          rows: [
            { name: 'b', n: '12' },
            { name: 'a', n: '0' },
          ],
        });
      },
    };
    expect(await tableCounts(db)).toEqual({ a: 0, b: 12 });
    expect(calls[0].sql).toContain("schemaname = 'public'");
    expect(calls[1]).toEqual({ sql: countsSql(['a', 'b']), values: ['a', 'b'] });
  });
});

describe('compareCounts', () => {
  it('no difference → empty', () => {
    expect(compareCounts({ a: 1, b: 2 }, { b: 2, a: 1 })).toEqual([]);
  });

  it('lists every difference, missing and extra tables included, sorted by name', () => {
    expect(compareCounts({ a: 1, b: 2, c: 3 }, { a: 1, b: 5, d: 0 })).toEqual([
      'b: expected 2, got 5',
      'c: expected 3, missing',
      'd: not expected, got 0',
    ]);
  });
});
