import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { AccountConsent, AccountOrdersPage, CustomerAddressView, OrderView } from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { Throttled, WriteThrottleGuard } from '../orders/write-throttle.js';
import { AccountService } from './account.service.js';
import { AccountErrorFilter, NoStoreInterceptor } from './customer-auth.controller.js';
import type { ResolvedCustomer } from './customer-session.service.js';
import { CurrentCustomer, CustomerSessionGuard } from './customer-session.guard.js';

/**
 * The signed-in customer's own data (spec §6.3, ACC-03, ACC-04, ACC-05): saved addresses, order history and the cancel
 * of an unpaid order, marketing consent. Every route needs a session (401 `not_authenticated`); writes need the
 * storefront origin; answers are never cached. Ids and order numbers of other accounts answer 404. Address and
 * consent writes count against `THROTTLE_ACCOUNT_LIMIT` per IP (bucket `account`), the cancel against `cancel`.
 */
@Controller('account')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard, CustomerSessionGuard)
@UseInterceptors(NoStoreInterceptor)
@UseFilters(AccountErrorFilter)
export class AccountController {
  constructor(private readonly account: AccountService) {}

  @Get('addresses')
  addresses(@CurrentCustomer() current: ResolvedCustomer): Promise<CustomerAddressView[]> {
    return this.account.addresses(current.customer.id);
  }

  @Post('addresses')
  @Throttled('account')
  createAddress(@CurrentCustomer() current: ResolvedCustomer, @Body() body: unknown): Promise<CustomerAddressView> {
    return this.account.createAddress(current.customer.id, body);
  }

  @Put('addresses/:id')
  @Throttled('account')
  updateAddress(
    @CurrentCustomer() current: ResolvedCustomer,
    @Param('id') id: string,
    @Body() body: unknown,
  ): Promise<CustomerAddressView> {
    return this.account.updateAddress(current.customer.id, id, body);
  }

  @Delete('addresses/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @Throttled('account')
  deleteAddress(@CurrentCustomer() current: ResolvedCustomer, @Param('id') id: string): Promise<void> {
    return this.account.deleteAddress(current.customer.id, id);
  }

  @Get('orders')
  orders(@CurrentCustomer() current: ResolvedCustomer, @Query('page') page: unknown): Promise<AccountOrdersPage> {
    return this.account.orderPage(current.customer.id, page);
  }

  @Get('orders/:number')
  order(@CurrentCustomer() current: ResolvedCustomer, @Param('number') number: string): Promise<OrderView> {
    return this.account.order(current.customer.id, number);
  }

  /** Cancels the account's own order while it waits for payment (the order link's rules, spec §4.2). */
  @Post('orders/:number/cancel')
  @Throttled('cancel')
  cancelOrder(@CurrentCustomer() current: ResolvedCustomer, @Param('number') number: string): Promise<OrderView> {
    return this.account.cancelOrder(current.customer.id, number);
  }

  @Put('consent')
  @Throttled('account')
  consent(@CurrentCustomer() current: ResolvedCustomer, @Body() body: unknown): Promise<AccountConsent> {
    return this.account.setConsent(current.customer, body);
  }
}
