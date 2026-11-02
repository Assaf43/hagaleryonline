import { buildColumns, headerKey, parseCell, slugFor, type Column, type ExcelLookups } from './excel-columns.js';

const lookups: ExcelLookups = {
  categories: new Map([['ספות › ספות פינתיות', { id: 3, slug: 'corner-sofas' }]]),
  rooms: new Map([['סלון', 1]]),
  attributes: [
    { code: 'color', nameHe: 'צבע', scope: 'variant', values: new Map([['בז׳', 'beige']]) },
    {
      code: 'style',
      nameHe: 'סגנון',
      scope: 'product',
      values: new Map([
        ['מודרני', 'modern'],
        ['נורדי', 'nordic'],
      ]),
    },
  ],
};
const columns = buildColumns(lookups);
const col = (key: string) => columns.find((c) => c.key === key) as Column;

describe('Excel columns', () => {
  it('has a column per attribute, product attributes allowing several values', () => {
    expect(col('attr:style')).toMatchObject({ header: 'סגנון', level: 'product', kind: 'multi' });
    expect(col('attr:color')).toMatchObject({ header: 'צבע', level: 'variant', kind: 'list', options: ['בז׳'] });
    expect(headerKey(' מק"ט * ')).toBe('מק"ט');
  });

  it('reads numbers the way people type them', () => {
    expect(parseCell(col('price'), '4,990 ₪')).toEqual({ ok: true, value: 499_000 });
    expect(parseCell(col('price'), 19.9)).toEqual({ ok: true, value: 1990 });
    expect(parseCell(col('widthCm'), '220.04')).toEqual({ ok: true, value: 220 });
    expect(parseCell(col('stock'), 'שלוש')).toEqual({ ok: false, code: 'number', value: 'שלוש' });
    expect(parseCell(col('stock'), 2.5)).toMatchObject({ ok: false, code: 'number' });
  });

  it('treats an empty cell as "no change"', () => {
    expect(parseCell(col('price'), null)).toBeNull();
    expect(parseCell(col('nameHe'), '   ')).toBeNull();
  });

  it('accepts only values from the closed lists', () => {
    expect(parseCell(col('attr:color'), 'בז׳')).toEqual({ ok: true, value: 'בז׳' });
    expect(parseCell(col('attr:color'), 'בז')).toEqual({ ok: false, code: 'not_in_list', value: 'בז' });
    expect(parseCell(col('attr:style'), 'מודרני, נורדי')).toEqual({ ok: true, value: ['מודרני', 'נורדי'] });
    expect(parseCell(col('attr:style'), 'מודרני, כפרי')).toEqual({ ok: false, code: 'not_in_list', value: 'כפרי' });
    expect(parseCell(col('requiresAssembly'), 'כן')).toEqual({ ok: true, value: true });
    expect(parseCell(col('requiresAssembly'), 'yes')).toMatchObject({ ok: false, code: 'yes_no' });
  });

  it('reads dates typed as day/month/year or stored by Excel', () => {
    expect(parseCell(col('expectedAt'), '5/1/2027')).toEqual({ ok: true, value: '2027-01-05' });
    expect(parseCell(col('expectedAt'), new Date('2027-01-05T00:00:00Z'))).toEqual({ ok: true, value: '2027-01-05' });
    expect(parseCell(col('expectedAt'), 'מחר')).toMatchObject({ ok: false, code: 'date' });
  });

  it('suggests the same slug as the admin form', () => {
    expect(slugFor('ALBA', 'corner-sofas')).toBe('alba-corner-sofa');
  });
});
