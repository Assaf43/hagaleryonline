import { Body, Controller, Get, Header, HttpCode, HttpStatus, Param, Post, UseGuards } from '@nestjs/common';
import type { StoreOrderCreated, StoreOrderRetry, StoreOrderStatus, StorePendingOrder } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { StoreOrdersService } from './store-orders.service.js';

/**
 * Store orders (spec §4.1 steps 3–5, §4.4, ADM-18, CHK-11): `/api/admin/store-orders`. Every call acts on the signed-in
 * seller's own store orders; another seller's order answers 404. Not throttled per IP (the store has one public IP,
 * spec §3): the seller is signed in with 2FA. No customer cookie is ever read or set.
 */
@Controller('admin/store-orders')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('orders.store')
export class StoreOrdersController {
  constructor(private readonly storeOrders: StoreOrdersService) {}

  /** The open cart becomes an order; the answer is its number and the provider's page to open on the tablet. */
  @Header('Cache-Control', 'no-store')
  @Post()
  create(
    @Body() body: unknown,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<StoreOrderCreated> {
    return this.storeOrders.create({ sellerId: admin.user.id, ip: client.ip }, body);
  }

  @Header('Cache-Control', 'no-store')
  @Get('pending')
  pending(@Admin() admin: AdminContext): Promise<StorePendingOrder[]> {
    return this.storeOrders.pending(admin.user.id);
  }

  @Header('Cache-Control', 'no-store')
  @Get(':number')
  status(@Param('number') number: string, @Admin() admin: AdminContext): Promise<StoreOrderStatus> {
    return this.storeOrders.status(admin.user.id, number);
  }

  @Header('Cache-Control', 'no-store')
  @Post(':number/retry')
  retry(@Param('number') number: string, @Admin() admin: AdminContext): Promise<StoreOrderRetry> {
    return this.storeOrders.retry(admin.user.id, number);
  }

  @Header('Cache-Control', 'no-store')
  @Post(':number/cancel')
  @HttpCode(HttpStatus.OK)
  cancel(
    @Param('number') number: string,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<StoreOrderStatus> {
    return this.storeOrders.cancel({ sellerId: admin.user.id, ip: client.ip }, number);
  }
}
