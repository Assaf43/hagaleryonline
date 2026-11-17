import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { NoStoreInterceptor } from '../common/no-store.interceptor.js';
import { Throttled, WriteThrottleGuard } from '../orders/write-throttle.js';
import { AccountErrorFilter } from './customer-auth.controller.js';
import { CurrentCustomer, CustomerSessionGuard } from './customer-session.guard.js';
import type { ResolvedCustomer } from './customer-session.service.js';
import { FavoritesService } from './favorites.service.js';

/**
 * The signed-in account's favorites (CLB-09, spec §5.5): `GET` the product ids newest first, `PUT { productIds }`
 * merges the device list in, `DELETE :productId` removes one. Needs a session; never cached; writes count against the
 * `account` throttle bucket.
 */
@Controller('account/favorites')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard, CustomerSessionGuard)
@UseInterceptors(NoStoreInterceptor)
@UseFilters(AccountErrorFilter)
export class FavoritesController {
  constructor(private readonly favorites: FavoritesService) {}

  @Get()
  list(@CurrentCustomer() current: ResolvedCustomer): Promise<number[]> {
    return this.favorites.list(current.customer.id);
  }

  @Put()
  @Throttled('account')
  merge(@CurrentCustomer() current: ResolvedCustomer, @Body() body: unknown): Promise<number[]> {
    return this.favorites.merge(current.customer.id, body);
  }

  @Delete(':productId')
  @Throttled('account')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentCustomer() current: ResolvedCustomer, @Param('productId') productId: string): Promise<void> {
    await this.favorites.remove(current.customer.id, productId);
  }
}
