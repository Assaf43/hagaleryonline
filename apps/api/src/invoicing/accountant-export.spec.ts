import ExcelJS from 'exceljs';
import type { AdminInvoiceRow } from '@hg/models';
import { buildAccountantWorkbook, dotDate, invoiceTotals, monthRange, parseMonth } from './accountant-export.js';

const row = (type: AdminInvoiceRow['type'], amount: number, vatAmount: number, extra = {}): AdminInvoiceRow => ({
  id: 'id-' + amount,
  type,
  number: 'N' + amount,
  orderNumber: 100001,
  issuedAt: '2026-11-05T10:00:00.000Z',
  amount,
  vatAmount,
  ...extra,
});

describe('parseMonth', () => {
  it('accepts YYYY-MM only', () => {
    expect(parseMonth('2026-11')).toBe('2026-11');
    for (const bad of ['2026-13', '2026-00', '2026-1', '2026-11-01', 'x', '', undefined, 5, null])
      expect(parseMonth(bad)).toBeNull();
  });
});

describe('monthRange (Israel time, DST-correct)', () => {
  it('a winter month runs from 22:00Z the day before', () => {
    const { from, to } = monthRange('2026-01');
    expect(from.toISOString()).toBe('2025-12-31T22:00:00.000Z');
    expect(to.toISOString()).toBe('2026-01-31T22:00:00.000Z');
  });
  it('a summer month starts at 21:00Z; March 2026 ends at the DST change (to = Apr 1 00:00 +03:00)', () => {
    expect(monthRange('2026-07').from.toISOString()).toBe('2026-06-30T21:00:00.000Z');
    const march = monthRange('2026-03');
    expect(march.from.toISOString()).toBe('2026-02-28T22:00:00.000Z');
    expect(march.to.toISOString()).toBe('2026-03-31T21:00:00.000Z');
  });
  it('December rolls into the next year', () => {
    expect(monthRange('2026-12').to.toISOString()).toBe('2026-12-31T22:00:00.000Z');
  });
});

describe('invoiceTotals', () => {
  it('sales − credits, VAT of invoices − VAT of credit notes', () => {
    const t = invoiceTotals([
      row('tax_invoice_receipt', 105_000, 16_017),
      row('tax_invoice_receipt', 11_800, 1_800),
      row('credit_note', 5_900, 900),
    ]);
    expect(t).toEqual({ sales: 116_800, credits: 5_900, net: 110_900, vat: 16_917 });
  });
  it('is zero without documents', () => {
    expect(invoiceTotals([])).toEqual({ sales: 0, credits: 0, net: 0, vat: 0 });
  });
});

describe('dotDate', () => {
  it('writes the Israel date as dd.MM.yyyy', () => {
    expect(dotDate(new Date('2026-11-05T22:30:00.000Z'))).toBe('06.11.2026');
  });
});

describe('buildAccountantWorkbook', () => {
  it('has the documents and summary sheets, RTL, Hebrew headers, money in shekels', async () => {
    const items = [row('tax_invoice_receipt', 11_800, 1_800), row('credit_note', 5_900, 900)];
    const buffer = await buildAccountantWorkbook('2026-11', items, invoiceTotals(items), 'https://admin.example.test');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);

    const docs = wb.getWorksheet('מסמכים')!;
    expect(docs.views[0]).toMatchObject({ rightToLeft: true });
    expect((docs.getRow(1).values as unknown[]).slice(1)).toEqual([
      'סוג',
      'מספר',
      'הזמנה',
      'תאריך',
      'סכום',
      'מע"מ',
      'קישור',
    ]);
    expect(docs.getRow(2).getCell(1).value).toBe('חשבונית מס/קבלה');
    expect(docs.getRow(3).getCell(1).value).toBe('חשבונית זיכוי');
    expect(docs.getRow(2).getCell(4).value).toBe('05.11.2026');
    expect(docs.getRow(2).getCell(5).value).toBe(118);
    expect(docs.getRow(2).getCell(5).numFmt).toContain('₪');
    expect(docs.getRow(2).getCell(6).value).toBe(18);
    const link = docs.getRow(2).getCell(7).value as { hyperlink?: string; text?: string } | string;
    expect(typeof link === 'string' ? link : link.hyperlink).toBe(
      'https://admin.example.test/api/admin/invoices/id-11800/document',
    );

    const sum = wb.getWorksheet('סיכום')!;
    expect(sum.views[0]).toMatchObject({ rightToLeft: true });
    const cells = new Map<string, unknown>();
    sum.eachRow((r) => cells.set(r.getCell(1).text, r.getCell(2).value));
    expect(cells.get('חודש')).toBe('11/2026');
    expect(cells.get('מכירות')).toBe(118);
    expect(cells.get('זיכויים')).toBe(59);
    expect(cells.get('נטו')).toBe(59);
    expect(cells.get('מע"מ')).toBe(9);
  });
});
