import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { StoreAdminController } from './store-admin.controller.js';
import { StoreCartController } from './store-cart.controller.js';
import { StoreCartService } from './store-cart.service.js';
import { StoreService } from './store.service.js';

/** Seller-assisted store orders (Phase 6, ADM-18). The store entity and the seller's store cart. */
@Module({
  imports: [AuthModule, CartModule],
  controllers: [StoreAdminController, StoreCartController],
  providers: [StoreService, StoreCartService],
  exports: [StoreService, StoreCartService],
})
export class StoreOrdersModule {}
