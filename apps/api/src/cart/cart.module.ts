import { forwardRef, Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { CouponController } from '../promotions/coupon.controller.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import { CartController } from './cart.controller.js';
import { CartService } from './cart.service.js';

@Module({
  imports: [AuthModule, CatalogModule, PromotionsModule, forwardRef(() => ShippingModule)],
  controllers: [CartController, CouponController],
  providers: [CartService],
  exports: [CartService],
})
export class CartModule {}
