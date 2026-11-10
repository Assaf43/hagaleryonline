import { BadRequestException, Controller, Get, Header, Param, Query, UseGuards } from '@nestjs/common';
import type { AdminOrderDetail, AdminOrderPage, ProvidersStatus } from '@hg/models';
import { AdminAuthGuard, RequirePermission, SameOriginGuard } from '../auth/guards.js';
import { ORDER_STATUS_FILTERS, OrdersAdminService, type OrderStatusFilter } from './orders-admin.service.js';

const invalid = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });

/** Orders (read-only, permission orders.view) and the providers status (Super Admin or orders.manage), spec §5.5. */
@Controller('admin')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class OrdersAdminController {
  constructor(private readonly orders: OrdersAdminService) {}

  @Get('orders')
  @RequirePermission('orders.view')
  @Header('Cache-Control', 'no-store')
  list(@Query('status') status: unknown, @Query('page') page: unknown): Promise<AdminOrderPage> {
    let filter: OrderStatusFilter | undefined;
    if (status !== undefined && status !== '') {
      if (typeof status !== 'string' || !(ORDER_STATUS_FILTERS as readonly string[]).includes(status))
        throw invalid('status');
      filter = status as OrderStatusFilter;
    }
    let pageNumber = 1;
    if (page !== undefined && page !== '') {
      if (typeof page !== 'string' || !/^\d{1,6}$/.test(page) || Number(page) < 1) throw invalid('page');
      pageNumber = Number(page);
    }
    return this.orders.list(filter, pageNumber);
  }

  @Get('orders/:number')
  @RequirePermission('orders.view')
  @Header('Cache-Control', 'no-store')
  detail(@Param('number') number: string): Promise<AdminOrderDetail> {
    return this.orders.detail(number);
  }

  /** The Super Admin holds every permission, so `orders.manage` covers both. */
  @Get('providers')
  @RequirePermission('orders.manage')
  providers(): ProvidersStatus {
    return this.orders.providers();
  }
}
