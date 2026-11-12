import type { InvoiceType } from './orders.js';

/**
 * Admin invoices page and the accountant export (spec §5.5, ADM-20): `GET /api/admin/invoices?month=YYYY-MM` and
 * `GET /api/admin/invoices/export?month=YYYY-MM` (`invoices.export`). Months are Israel-time months. Money is
 * integer agorot, VAT included; a credit note's amounts are positive (its type says it is a credit).
 */
export interface AdminInvoiceRow {
  id: string;
  type: InvoiceType;
  number: string;
  orderNumber: number;
  /** ISO instant. */
  issuedAt: string;
  amount: number;
  vatAmount: number;
}

/** `sales` = tax invoices, `credits` = credit notes (positive), `net` = sales − credits, `vat` = VAT of invoices − VAT of credit notes. */
export interface AdminInvoiceTotals {
  sales: number;
  credits: number;
  net: number;
  vat: number;
}

export interface AdminInvoicesMonth {
  /** YYYY-MM. */
  month: string;
  items: AdminInvoiceRow[];
  totals: AdminInvoiceTotals;
}

/** One row of the VAT rate table (`GET /api/admin/settings/vat`, Super Admin only). */
export interface AdminVatRate {
  id: number;
  /** A fraction: 0.18. */
  rate: number;
  /** YYYY-MM-DD, an Israel calendar date. */
  effectiveFrom: string;
}

/** `POST /api/admin/settings/vat`: a future rate (`0 < rate < 1`, up to 4 decimals; the date is after today and after every existing one). */
export interface AdminVatRateInput {
  rate: number;
  effectiveFrom: string;
}
