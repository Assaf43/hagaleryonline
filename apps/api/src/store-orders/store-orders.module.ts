import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { MarketingModule } from '../marketing/marketing.module.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WriteThrottleModule } from '../orders/write-throttle.module.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import { StoreAdminController } from './store-admin.controller.js';
import { StoreCartController } from './store-cart.controller.js';
import { StoreCartService } from './store-cart.service.js';
import { StoreCustomerService } from './store-customer.service.js';
import { StoreOrdersController } from './store-orders.controller.js';
import { StoreOrdersService } from './store-orders.service.js';
import { StoreService } from './store.service.js';

/**
 * Seller-assisted store orders (Phase 6, ADM-18). The store entity, the seller's store cart, the customer's
 * confirmation by code, and the store order on the website's checkout path.
 */
@Module({
  imports: [
    AuthModule,
    CartModule,
    CustomersModule,
    MarketingModule,
    OrdersModule,
    ShippingModule,
    WriteThrottleModule,
  ],
  controllers: [StoreAdminController, StoreCartController, StoreOrdersController],
  providers: [StoreService, StoreCartService, StoreCustomerService, StoreOrdersService],
  exports: [StoreService, StoreCartService],
})
export class StoreOrdersModule {}
