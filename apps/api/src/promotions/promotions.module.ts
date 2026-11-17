import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PersonalCodesAdminController } from './personal-codes-admin.controller.js';
import { PersonalCodesService } from './personal-codes.service.js';
import { PromotionsAdminController } from './promotions-admin.controller.js';
import { PromotionsAdminService } from './promotions-admin.service.js';
import { PromotionsService } from './promotions.service.js';
import { WelcomeController } from './welcome.controller.js';

/**
 * Promotions and coupons (spec §6), their admin screen (`promotions-admin.*`), the public welcome label, and personal
 * codes (`PersonalCodesService`: the welcome code of new accounts, codes issued by staff, the account's benefits). The coupon endpoints
 * (`coupon.controller.ts`) belong to the cart and are registered by CartModule, which imports this module.
 */
@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [PromotionsAdminController, WelcomeController, PersonalCodesAdminController],
  providers: [PromotionsService, PromotionsAdminService, PersonalCodesService],
  exports: [PromotionsService, PersonalCodesService],
})
export class PromotionsModule {}
