import ExcelJS from 'exceljs';
import { INVOICE_TYPE_LABELS_HE, type AdminInvoiceRow, type AdminInvoiceTotals } from '@hg/models';
import { israelDate, israelMidnightUtc } from './vat.js';

const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** `YYYY-MM` or null. */
export function parseMonth(value: unknown): string | null {
  return typeof value === 'string' && MONTH.test(value) ? value : null;
}

/** The Israel-time month as a half-open range: [first day 00:00, first day of the next month 00:00). */
export function monthRange(month: string): { from: Date; to: Date } {
  const [, y, m] = MONTH.exec(month)!;
  const year = Number(y);
  const next = Number(m) === 12 ? `${year + 1}-01-01` : `${y}-${String(Number(m) + 1).padStart(2, '0')}-01`;
  return { from: israelMidnightUtc(`${y}-${m}-01`), to: israelMidnightUtc(next) };
}

export function invoiceTotals(
  rows: readonly Pick<AdminInvoiceRow, 'type' | 'amount' | 'vatAmount'>[],
): AdminInvoiceTotals {
  let sales = 0;
  let credits = 0;
  let vat = 0;
  for (const r of rows) {
    if (r.type === 'credit_note') {
      credits += r.amount;
      vat -= r.vatAmount;
    } else {
      sales += r.amount;
      vat += r.vatAmount;
    }
  }
  return { sales, credits, net: sales - credits, vat };
}

/** The Israel date of an instant as dd.MM.yyyy. */
export function dotDate(at: Date): string {
  const [y, m, d] = israelDate(at).split('-');
  return `${d}.${m}.${y}`;
}

const MONEY_FORMAT = '#,##0.00 "₪"';
const shekels = (agorot: number) => agorot / 100;

/**
 * The accountant's workbook (spec §5.5): "מסמכים" (one row per document, by issue time) and "סיכום" (month and the
 * four totals). Hebrew headers, right-to-left sheets, money as numbers in shekels. `adminBase` is the admin's
 * address (empty = relative links).
 */
export async function buildAccountantWorkbook(
  month: string,
  rows: readonly AdminInvoiceRow[],
  totals: AdminInvoiceTotals,
  adminBase: string,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const docs = wb.addWorksheet('מסמכים', { views: [{ rightToLeft: true, state: 'frozen', ySplit: 1 }] });
  docs.columns = [
    { header: 'סוג', key: 'type', width: 20 },
    { header: 'מספר', key: 'number', width: 18 },
    { header: 'הזמנה', key: 'order', width: 12 },
    { header: 'תאריך', key: 'date', width: 14 },
    { header: 'סכום', key: 'amount', width: 14, style: { numFmt: MONEY_FORMAT } },
    { header: 'מע"מ', key: 'vat', width: 14, style: { numFmt: MONEY_FORMAT } },
    { header: 'קישור', key: 'link', width: 60 },
  ];
  docs.getRow(1).font = { bold: true };
  for (const r of rows) {
    const url = `${adminBase.replace(/\/$/, '')}/api/admin/invoices/${r.id}/document`;
    docs.addRow({
      type: INVOICE_TYPE_LABELS_HE[r.type],
      number: r.number,
      order: r.orderNumber,
      date: dotDate(new Date(r.issuedAt)),
      amount: shekels(r.amount),
      vat: shekels(r.vatAmount),
      link: { text: url, hyperlink: url },
    });
  }

  const sum = wb.addWorksheet('סיכום', { views: [{ rightToLeft: true }] });
  sum.columns = [
    { key: 'label', width: 16 },
    { key: 'value', width: 18 },
  ];
  const [y, m] = month.split('-');
  sum.addRow(['חודש', `${m}/${y}`]);
  for (const [label, agorot] of [
    ['מכירות', totals.sales],
    ['זיכויים', totals.credits],
    ['נטו', totals.net],
    ['מע"מ', totals.vat],
  ] as const) {
    const row = sum.addRow([label, shekels(agorot)]);
    row.getCell(2).numFmt = MONEY_FORMAT;
  }
  sum.getColumn(1).font = { bold: true };

  return Buffer.from(await wb.xlsx.writeBuffer());
}
