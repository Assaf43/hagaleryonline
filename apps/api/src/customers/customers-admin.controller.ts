import { Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import type { CodeTemplateOption, CustomerPage, CustomerProfile } from '@hg/models';
import { AdminAuthGuard, RequirePermission, SameOriginGuard } from '../auth/guards.js';
import { CustomersAdminService, parseCustomerQuery } from './customers-admin.service.js';

/**
 * The admin "לקוחות" screens (spec §4.5, CLB-09, `customers.view`): `GET /api/admin/customers?q=&page=` and
 * `GET /api/admin/customers/:id`. Reads only, never cached. `code-templates` (the issue dialog's list) is a method-level
 * `club.manage`, declared before `:id`. Issuing a code is `PersonalCodesAdminController`.
 */
@Controller('admin/customers')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('customers.view')
export class CustomersAdminController {
  constructor(private readonly customers: CustomersAdminService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  list(@Query('q') q: unknown, @Query('page') page: unknown): Promise<CustomerPage> {
    return this.customers.list(parseCustomerQuery({ q, page }));
  }

  @Get('code-templates')
  @RequirePermission('club.manage')
  @Header('Cache-Control', 'no-store')
  codeTemplates(): Promise<CodeTemplateOption[]> {
    return this.customers.codeTemplates();
  }

  @Get(':id')
  @Header('Cache-Control', 'no-store')
  profile(@Param('id') id: string): Promise<CustomerProfile> {
    return this.customers.profile(id);
  }
}
