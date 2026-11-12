import type { InvoiceType as InvoiceTypeView, OrderInvoiceView } from '@hg/models';
import { InvoiceType, type Prisma } from '../generated/prisma/client.js';

export const INVOICE_TYPE_VIEW: Record<InvoiceType, InvoiceTypeView> = {
  TAX_INVOICE_RECEIPT: 'tax_invoice_receipt',
  CREDIT_NOTE: 'credit_note',
};

export const INVOICE_TYPE_DB: Record<InvoiceTypeView, InvoiceType> = {
  tax_invoice_receipt: InvoiceType.TAX_INVOICE_RECEIPT,
  credit_note: InvoiceType.CREDIT_NOTE,
};

/** Prisma `include` of an order's documents, oldest first (the order page and the admin order detail). */
export const ORDER_INVOICES = {
  invoices: {
    select: { id: true, type: true, number: true, issuedAt: true },
    orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.OrderInclude;

export function invoiceViews(
  rows: readonly { id: string; type: InvoiceType; number: string; issuedAt: Date }[],
): OrderInvoiceView[] {
  return rows.map((r) => ({
    id: r.id,
    type: INVOICE_TYPE_VIEW[r.type],
    number: r.number,
    issuedAt: r.issuedAt.toISOString(),
  }));
}
