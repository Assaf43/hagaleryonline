import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminInvoicesMonth, AdminInvoiceRow } from '@hg/models';
import { PrismaService } from '../prisma/prisma.service.js';
import { buildAccountantWorkbook, invoiceTotals, monthRange } from './accountant-export.js';
import { INVOICE_TYPE_VIEW } from './invoice-view.js';

/** The documents of one Israel-time month, and the accountant's workbook made from them (spec §5.5, ADM-20). */
@Injectable()
export class InvoicesReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async month(month: string): Promise<AdminInvoicesMonth> {
    const { from, to } = monthRange(month);
    const rows = await this.prisma.invoice.findMany({
      where: { issuedAt: { gte: from, lt: to } },
      orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        type: true,
        number: true,
        issuedAt: true,
        amount: true,
        vatAmount: true,
        order: { select: { number: true } },
      },
    });
    const items: AdminInvoiceRow[] = rows.map((r) => ({
      id: r.id,
      type: INVOICE_TYPE_VIEW[r.type],
      number: r.number,
      orderNumber: r.order.number,
      issuedAt: r.issuedAt.toISOString(),
      amount: r.amount,
      vatAmount: r.vatAmount,
    }));
    return { month, items, totals: invoiceTotals(items) };
  }

  async export(month: string): Promise<Buffer> {
    const { items, totals } = await this.month(month);
    return buildAccountantWorkbook(month, items, totals, this.config.get<string>('ADMIN_URL') ?? '');
  }
}
