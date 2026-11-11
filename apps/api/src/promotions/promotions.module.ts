import { Module } from '@nestjs/common';
import { PromotionsService } from './promotions.service.js';

/**
 * Promotions and coupons (spec §6). The coupon endpoints (`coupon.controller.ts`) belong to the cart and are
 * registered by CartModule, which imports this module.
 */
@Module({
  providers: [PromotionsService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
