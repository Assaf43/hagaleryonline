import { Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import type { CheckoutResponse, OrderView } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';
import { OrdersService } from './orders.service.js';
import { Throttled, WriteThrottleGuard } from './write-throttle.js';

/** The confirmation page's API (spec §5.4, §5.5). The `t` token in the URL is the only key; POSTs need the storefront origin. */
@Controller('orders')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard)
export class OrdersController {
  constructor(
    private readonly orders: OrdersService,
    private readonly lifecycle: OrderLifecycleService,
  ) {}

  @Get(':number')
  @Header('Cache-Control', 'no-store')
  view(@Param('number') number: string, @Query('t') token: unknown): Promise<OrderView> {
    return this.orders.view(number, { token: typeof token === 'string' ? token : undefined });
  }

  /** Cancels an order that is still waiting for payment (spec §4.2). */
  @Post(':number/cancel')
  @Throttled('cancel')
  cancel(@Param('number') number: string, @Query('t') token: unknown): Promise<OrderView> {
    return this.lifecycle.cancelByCustomer(number, { token: typeof token === 'string' ? token : undefined });
  }

  @Post(':number/retry-payment')
  @Throttled('retry')
  retry(@Param('number') number: string, @Query('t') token: unknown): Promise<CheckoutResponse> {
    return this.orders.retryPayment(number, typeof token === 'string' ? token : undefined);
  }
}
