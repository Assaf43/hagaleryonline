import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { WriteThrottleModule } from '../orders/write-throttle.module.js';
import { StoreAdminController } from './store-admin.controller.js';
import { StoreCartController } from './store-cart.controller.js';
import { StoreCartService } from './store-cart.service.js';
import { StoreCustomerService } from './store-customer.service.js';
import { StoreService } from './store.service.js';

/**
 * Seller-assisted store orders (Phase 6, ADM-18). The store entity, the seller's store cart and the customer's
 * confirmation by code.
 */
@Module({
  imports: [AuthModule, CartModule, CustomersModule, WriteThrottleModule],
  controllers: [StoreAdminController, StoreCartController],
  providers: [StoreService, StoreCartService, StoreCustomerService],
  exports: [StoreService, StoreCartService],
})
export class StoreOrdersModule {}
