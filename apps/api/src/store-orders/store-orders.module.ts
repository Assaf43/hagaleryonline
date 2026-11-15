import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { StoreAdminController } from './store-admin.controller.js';
import { StoreService } from './store.service.js';

/** Seller-assisted store orders (Phase 6, ADM-18). Task 1: the store entity. */
@Module({
  imports: [AuthModule],
  controllers: [StoreAdminController],
  providers: [StoreService],
  exports: [StoreService],
})
export class StoreOrdersModule {}
