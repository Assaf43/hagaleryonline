import type { InvoiceType } from '@hg/models';

/** One line of a tax document. Agorot, VAT included; a discount is a line with a negative price. */
export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

/** What a provider needs to issue one document (spec §5.4). */
export interface InvoiceIssueInput {
  type: InvoiceType;
  orderNumber: number;
  customer: { fullName: string; email: string; phone: string };
  lines: InvoiceLine[];
  /** Agorot, VAT included: the order total or the refund amount (positive for a credit note too). */
  amount: number;
  /** Agorot: the VAT inside `amount`, computed by us from the VAT rate table. */
  vatAmount: number;
  /** The rate `vatAmount` was computed with (0.18), shown on the document. */
  vatRate: number;
  /** The same key always gives the same document: a retry never issues twice. */
  idempotencyKey: string;
}

export interface InvoiceIssueResult {
  /** The provider's document number. */
  number: string;
  /** The provider's own link to the document, when it hosts it. */
  documentUrl: string | null;
  /** The document itself, when the provider hands it over: we keep it in the private storage area. */
  file?: Buffer;
}

/**
 * An invoicing system (CLAUDE.md §4.2, spec §5.4, decision 81). Every provider is its own adapter; business code
 * talks only to this interface, and every `Invoice` stores the `code` of the provider that issued it. `issue` must be
 * idempotent by `idempotencyKey`.
 */
export interface InvoiceProvider {
  readonly code: string;
  issue(input: InvoiceIssueInput): Promise<InvoiceIssueResult>;
}

/** Injection token of the active provider, chosen by the `INVOICE_PROVIDER` env variable (required, no default). */
export const INVOICE_PROVIDER = 'INVOICE_PROVIDER';
