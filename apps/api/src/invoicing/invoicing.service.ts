import { Inject, Injectable, Logger, NotFoundException, type OnModuleInit } from '@nestjs/common';
import type { InvoiceType as InvoiceTypeView } from '@hg/models';
import { InvoiceType, PaymentStatus, Prisma, RefundStatus } from '../generated/prisma/client.js';
import { StorageProvider } from '../media/storage.js';
import { parseOrderNumber } from '../orders/order-number.js';
import { tokenMatches } from '../orders/orders.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { creditNoteLines, orderInvoiceLines } from './invoice-lines.js';
import { INVOICE_PROVIDER, type InvoiceLine, type InvoiceProvider } from './invoice-provider.js';
import { INVOICE_TYPE_DB } from './invoice-view.js';
import { vatOf, vatRateOn } from './vat.js';

interface InvoiceJob {
  orderId: string;
}
interface CreditNoteJob extends InvoiceJob {
  refundId: string;
}

/** A stored document, ready to send to the browser. */
export interface InvoiceDocument {
  content: Buffer;
  contentType: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const notFound = () => new NotFoundException({ statusCode: 404, code: 'not_found' });

/**
 * Tax documents (spec §5.4, CHK-08, decision 81). The outbox jobs `invoice.issue:<orderId>` (an order became paid)
 * and `invoice.credit_note:<refundId>` (a refund succeeded) issue them through the active `InvoiceProvider`.
 *
 * Exactly once: the job's dedupe key is the `Invoice.idempotencyKey` (unique). A run first looks for the invoice of
 * its key and stops when it exists; otherwise it asks the provider with that key (the provider returns the same
 * document for the same key), keeps the file privately, and inserts the row. When a concurrent run inserted it first,
 * the unique violation means the work is done. Any other error throws, so the outbox retries.
 */
@Injectable()
export class InvoicingService implements OnModuleInit {
  private readonly logger = new Logger(InvoicingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly storage: StorageProvider,
    @Inject(INVOICE_PROVIDER) private readonly provider: InvoiceProvider,
  ) {}

  onModuleInit(): void {
    this.outbox.register<InvoiceJob>('invoice.issue', (p, job) => this.issueInvoice(p, job.dedupeKey));
    this.outbox.register<CreditNoteJob>('invoice.credit_note', (p, job) => this.issueCreditNote(p, job.dedupeKey));
  }

  /** The tax invoice / receipt of a paid order: its items, shipping and discount lines; amount = order total. */
  async issueInvoice({ orderId }: InvoiceJob, idempotencyKey: string): Promise<void> {
    if (await this.issued(idempotencyKey)) return;
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { id: 'asc' } }, payments: { select: { status: true } } },
    });
    if (!order) {
      this.logger.warn(`Order ${orderId} no longer exists: no invoice is issued`);
      return;
    }
    if (!order.payments.some((p) => p.status === PaymentStatus.SUCCEEDED))
      throw new Error(`Order ${order.number} has no successful payment: no tax invoice is issued`);
    await this.issue({
      type: 'tax_invoice_receipt',
      idempotencyKey,
      order,
      refundId: null,
      lines: orderInvoiceLines(order),
      amount: order.total,
    });
  }

  /** The credit note of a succeeded refund: one line, amount = the refund. It waits for the order's tax invoice. */
  async issueCreditNote({ orderId, refundId }: CreditNoteJob, idempotencyKey: string): Promise<void> {
    if (await this.issued(idempotencyKey)) return;
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, include: { order: true } });
    if (!refund || refund.orderId !== orderId) {
      this.logger.warn(`Refund ${refundId} of order ${orderId} no longer exists: no credit note is issued`);
      return;
    }
    if (refund.status !== RefundStatus.SUCCEEDED)
      throw new Error(`Refund ${refundId} has not succeeded: no credit note is issued`);
    const invoiced = await this.prisma.invoice.count({
      where: { orderId, type: InvoiceType.TAX_INVOICE_RECEIPT },
    });
    // A credit note credits a tax invoice: when the invoice job has not run yet (or failed), retry later.
    if (invoiced === 0) throw new Error(`Order ${refund.order.number} has no tax invoice yet: the credit note waits`);
    await this.issue({
      type: 'credit_note',
      idempotencyKey,
      order: refund.order,
      refundId,
      lines: creditNoteLines(refund.order.number, refund.amount),
      amount: refund.amount,
    });
  }

  private async issued(idempotencyKey: string): Promise<boolean> {
    return (await this.prisma.invoice.count({ where: { idempotencyKey } })) > 0;
  }

  private async issue(doc: {
    type: InvoiceTypeView;
    idempotencyKey: string;
    order: { id: string; number: number; contact: Prisma.JsonValue };
    refundId: string | null;
    lines: InvoiceLine[];
    amount: number;
  }): Promise<void> {
    const issuedAt = new Date();
    const rates = await this.prisma.vatRate.findMany();
    const vatRate = vatRateOn(
      rates.map((r) => ({ rate: r.rate.toNumber(), effectiveFrom: r.effectiveFrom })),
      issuedAt,
    );
    const vatAmount = vatOf(doc.amount, vatRate);
    const contact = (doc.order.contact ?? {}) as { fullName?: unknown; email?: unknown; phone?: unknown };
    const result = await this.provider.issue({
      type: doc.type,
      orderNumber: doc.order.number,
      customer: { fullName: text(contact.fullName), email: text(contact.email), phone: text(contact.phone) },
      lines: doc.lines,
      amount: doc.amount,
      vatAmount,
      vatRate,
      idempotencyKey: doc.idempotencyKey,
    });
    let fileKey: string | null = null;
    if (result.file) {
      fileKey = `invoices/${result.number.replace(/[^A-Za-z0-9._-]/g, '_')}.${isPdf(result.file) ? 'pdf' : 'html'}`;
      await this.storage.put(fileKey, result.file, 'private');
    }
    try {
      await this.prisma.invoice.create({
        data: {
          orderId: doc.order.id,
          type: INVOICE_TYPE_DB[doc.type],
          refundId: doc.refundId,
          provider: this.provider.code,
          number: result.number,
          documentUrl: result.documentUrl,
          fileKey,
          amount: doc.amount,
          vatAmount,
          vatRate: new Prisma.Decimal(vatRate),
          issuedAt,
          idempotencyKey: doc.idempotencyKey,
        },
      });
    } catch (error) {
      // A concurrent run of the same job inserted it first: the same document (same key), so this run is done too.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002' &&
        (await this.issued(doc.idempotencyKey))
      )
        return;
      throw error;
    }
    this.logger.log(`Issued ${doc.type} ${result.number} for order ${doc.order.number}`);
  }

  /** GET /api/orders/:number/invoices/:id?t= — 404 for a wrong token or a document of another order. */
  async documentForCustomer(numberParam: string, token: string | undefined, id: string): Promise<InvoiceDocument> {
    const number = parseOrderNumber(numberParam);
    if (number === null || typeof token !== 'string' || !UUID.test(id)) throw notFound();
    const order = await this.prisma.order.findUnique({ where: { number }, select: { id: true, publicToken: true } });
    if (!order || !tokenMatches(token, order.publicToken)) throw notFound();
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { orderId: true, fileKey: true } });
    if (!invoice || invoice.orderId !== order.id) throw notFound();
    return this.read(invoice.fileKey);
  }

  /** GET /api/admin/invoices/:id/document (`invoices.export`). */
  async documentForAdmin(id: string): Promise<InvoiceDocument> {
    if (!UUID.test(id)) throw notFound();
    const invoice = await this.prisma.invoice.findUnique({ where: { id }, select: { fileKey: true } });
    if (!invoice) throw notFound();
    return this.read(invoice.fileKey);
  }

  /** A provider that only hosts its documents (no file kept here) has nothing to stream yet. */
  private async read(fileKey: string | null): Promise<InvoiceDocument> {
    if (!fileKey) throw notFound();
    const content = await this.storage.read(fileKey, 'private');
    if (!content) {
      this.logger.error(`Invoice file ${fileKey} is missing from the private storage`);
      throw notFound();
    }
    return {
      content,
      contentType: fileKey.endsWith('.pdf') ? 'application/pdf' : 'text/html; charset=utf-8',
    };
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const isPdf = (file: Buffer): boolean => file.subarray(0, 5).toString('latin1') === '%PDF-';
