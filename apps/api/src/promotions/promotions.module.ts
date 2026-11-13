import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { PromotionsAdminController } from './promotions-admin.controller.js';
import { PromotionsAdminService } from './promotions-admin.service.js';
import { PromotionsService } from './promotions.service.js';
import { WelcomeController } from './welcome.controller.js';

/**
 * Promotions and coupons (spec §6), their admin screen (`promotions-admin.*`) and the public welcome label. The coupon endpoints
 * (`coupon.controller.ts`) belong to the cart and are registered by CartModule, which imports this module.
 */
@Module({
  imports: [AuthModule],
  controllers: [PromotionsAdminController, WelcomeController],
  providers: [PromotionsService, PromotionsAdminService],
  exports: [PromotionsService],
})
export class PromotionsModule {}
