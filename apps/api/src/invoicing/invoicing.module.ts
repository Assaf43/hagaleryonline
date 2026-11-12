import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { selectProvider } from '../providers/select-provider.js';
import { INVOICE_PROVIDER, type InvoiceProvider } from './invoice-provider.js';
import { InvoicesAdminController, VatAdminController } from './invoices-admin.controller.js';
import { InvoicesController } from './invoices.controller.js';
import { InvoicesReportService } from './invoices-report.service.js';
import { InvoicingService } from './invoicing.service.js';
import { MockInvoiceProvider } from './mock-invoice.provider.js';
import { VatAdminService } from './vat-admin.service.js';

/**
 * Invoices and credit notes (spec §5.4, CHK-08). The active adapter comes from `INVOICE_PROVIDER` (required, no
 * default); adapters are built only when selected, so the mock's refusal to run in production stops the API only
 * when it is the one configured. The outbox handlers `invoice.issue` and `invoice.credit_note` are registered here.
 */
@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [InvoicesController, InvoicesAdminController, VatAdminController],
  providers: [
    InvoicingService,
    InvoicesReportService,
    VatAdminService,
    {
      provide: INVOICE_PROVIDER,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService): InvoiceProvider =>
        selectProvider<InvoiceProvider>('INVOICE_PROVIDER', config.get<string>('INVOICE_PROVIDER'), {
          mock: () => new MockInvoiceProvider(config, prisma),
        }),
    },
  ],
  exports: [InvoicingService],
})
export class InvoicingModule {}
