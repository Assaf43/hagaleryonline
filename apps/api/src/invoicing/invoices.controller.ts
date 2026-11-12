import { Controller, Get, Header, Param, Query, StreamableFile } from '@nestjs/common';
import { InvoicingService, type InvoiceDocument } from './invoicing.service.js';

/** A stored document runs nothing and loads nothing: only its inline styles and data: images. */
export const DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

/** The document opens in the browser tab; never cached, never indexed. */
export const stream = (doc: InvoiceDocument) =>
  new StreamableFile(doc.content, { type: doc.contentType, disposition: 'inline' });

/**
 * A customer's tax documents (spec §5.4): `GET /api/orders/:number/invoices/:id?t=<order token>`. The order token is
 * the only key (the account session joins in Phase 5c); a wrong token or a document of another order is 404.
 */
@Controller('orders')
export class InvoicesController {
  constructor(private readonly invoicing: InvoicingService) {}

  @Get(':number/invoices/:id')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex')
  @Header('Content-Security-Policy', DOCUMENT_CSP)
  @Header('X-Content-Type-Options', 'nosniff')
  async document(
    @Param('number') number: string,
    @Param('id') id: string,
    @Query('t') token: unknown,
  ): Promise<StreamableFile> {
    return stream(await this.invoicing.documentForCustomer(number, typeof token === 'string' ? token : undefined, id));
  }
}
