import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { AdminOrderDetail, OrderStatus, AdminOrderPage, ProvidersStatus } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';
import { ORDER_STATUS_FILTERS, OrdersAdminService, type OrderStatusFilter } from './orders-admin.service.js';

const invalid = (field: string) => new BadRequestException({ statusCode: 400, code: 'invalid_input', field });

/** Orders (read-only, permission orders.view) and the providers status (Super Admin or orders.manage), spec §5.5. */
@Controller('admin')
@UseGuards(SameOriginGuard, AdminAuthGuard)
export class OrdersAdminController {
  constructor(
    private readonly orders: OrdersAdminService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get('orders')
  @RequirePermission('orders.view')
  @Header('Cache-Control', 'no-store')
  list(
    @Query('status') status: unknown,
    @Query('page') page: unknown,
    @Query('attention') attention: unknown,
  ): Promise<AdminOrderPage> {
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
    if (attention !== undefined && attention !== '' && attention !== 'true') throw invalid('attention');
    return this.orders.list(filter, pageNumber, attention === 'true');
  }

  @Get('orders/:number')
  @RequirePermission('orders.view')
  @Header('Cache-Control', 'no-store')
  detail(@Param('number') number: string): Promise<AdminOrderDetail> {
    return this.orders.detail(number);
  }

  /** Moves the order forward (spec §4.1); `delivery_scheduled` carries the delivery slot. */
  @Post('orders/:number/status')
  @RequirePermission('orders.manage')
  advance(
    @Param('number') number: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminOrderDetail> {
    const { to, slot } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    if (typeof to !== 'string') throw invalid('to');
    return this.lifecycle.advance(number, to as OrderStatus, { adminId: admin.user.id, ip: client.ip }, slot);
  }

  /** Cancels a paid or unpaid order and refunds as decided (decisions 73–74); `orders.cancel`. */
  @Post('orders/:number/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.cancel')
  cancel(
    @Param('number') number: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminOrderDetail> {
    return this.lifecycle.cancelByAdmin(number, body, { adminId: admin.user.id, ip: client.ip });
  }

  /** A refund without cancelling (a delivered order whose return was closed). */
  @Post('orders/:number/refunds')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.cancel')
  refund(
    @Param('number') number: string,
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminOrderDetail> {
    return this.lifecycle.refundByAdmin(number, body, { adminId: admin.user.id, ip: client.ip });
  }

  /** "נסה שוב" on a failed (or lost) refund: the same idempotency key. */
  @Post('orders/:number/refunds/:id/retry')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('orders.cancel')
  retryRefund(
    @Param('number') number: string,
    @Param('id') id: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminOrderDetail> {
    return this.lifecycle.retryRefund(number, id, { adminId: admin.user.id, ip: client.ip });
  }

  /** The Super Admin holds every permission, so `orders.manage` covers both. */
  @Get('providers')
  @RequirePermission('orders.manage')
  @Header('Cache-Control', 'no-store')
  providers(): ProvidersStatus {
    return this.orders.providers();
  }
}
