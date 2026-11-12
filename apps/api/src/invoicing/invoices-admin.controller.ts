import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  Param,
  Post,
  Query,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { AdminInvoicesMonth, AdminVatRate } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  SuperAdminOnly,
  type AdminContext,
} from '../auth/guards.js';
import { parseMonth } from './accountant-export.js';
import { DOCUMENT_CSP, stream } from './invoices.controller.js';
import { InvoicesReportService } from './invoices-report.service.js';
import { InvoicingService } from './invoicing.service.js';
import { VatAdminService, parseVatInput } from './vat-admin.service.js';

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

function monthOf(value: unknown): string {
  const month = parseMonth(value);
  if (!month) throw new BadRequestException({ statusCode: 400, code: 'invalid_input', field: 'month' });
  return month;
}

/**
 * Staff documents (permission `invoices.export`): the month list, the accountant's export (spec §5.5, ADM-20) and
 * any single document, opened from the order page or the list.
 */
@Controller('admin/invoices')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class InvoicesAdminController {
  constructor(
    private readonly invoicing: InvoicingService,
    private readonly report: InvoicesReportService,
  ) {}

  @Get()
  @RequirePermission('invoices.export')
  list(@Query('month') month: unknown): Promise<AdminInvoicesMonth> {
    return this.report.month(monthOf(month));
  }

  @Get('export')
  @RequirePermission('invoices.export')
  @Header('Cache-Control', 'private, no-store')
  async export(@Query('month') month: unknown): Promise<StreamableFile> {
    const m = monthOf(month);
    const data = await this.report.export(m);
    return new StreamableFile(data, {
      type: XLSX,
      disposition: `attachment; filename="invoices-${m}.xlsx"`,
      length: data.length,
    });
  }

  @Get(':id/document')
  @RequirePermission('invoices.export')
  @Header('Cache-Control', 'private, no-store')
  @Header('X-Robots-Tag', 'noindex')
  @Header('Content-Security-Policy', DOCUMENT_CSP)
  @Header('X-Content-Type-Options', 'nosniff')
  async document(@Param('id') id: string): Promise<StreamableFile> {
    return stream(await this.invoicing.documentForAdmin(id));
  }
}

/** The VAT rate table: Super Admin only; rates are added for a future date, never edited or deleted. */
@Controller('admin/settings/vat')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@SuperAdminOnly()
export class VatAdminController {
  constructor(private readonly vat: VatAdminService) {}

  @Get()
  list(): Promise<AdminVatRate[]> {
    return this.vat.list();
  }

  @Post()
  add(@Body() body: unknown, @Admin() admin: AdminContext, @ClientMeta() client: RequestMeta): Promise<AdminVatRate> {
    return this.vat.add(parseVatInput(body), { actorId: admin.user.id, ip: client.ip });
  }
}
