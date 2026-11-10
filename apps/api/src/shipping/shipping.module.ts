import { forwardRef, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { LocalitiesController } from './localities.controller.js';
import { LocalitiesService } from './localities.service.js';
import { ManualShippingProvider } from './manual-shipping.provider.js';
import { SHIPPING_PROVIDER, selectShippingProvider } from './shipping-provider.js';
import { ShippingAdminController } from './shipping-admin.controller.js';
import { ShippingAdminService } from './shipping-admin.service.js';
import { ShippingController } from './shipping.controller.js';
import { ShippingPriceList, ShippingService } from './shipping.service.js';

/**
 * Localities, the shipping price list and its admin screen (spec §4.4), and the active `ShippingProvider` (spec §4).
 * The cart needs the "from" price and the quote needs the cart, hence the forwardRef with CartModule.
 */
@Module({
  imports: [AuthModule, forwardRef(() => CartModule)],
  controllers: [LocalitiesController, ShippingController, ShippingAdminController],
  providers: [
    LocalitiesService,
    ShippingPriceList,
    ShippingService,
    ShippingAdminService,
    ManualShippingProvider,
    {
      provide: SHIPPING_PROVIDER,
      inject: [ConfigService, ManualShippingProvider],
      useFactory: (config: ConfigService, manual: ManualShippingProvider) =>
        selectShippingProvider(config.get<string>('SHIPPING_PROVIDER'), [manual]),
    },
  ],
  exports: [LocalitiesService, ShippingService, SHIPPING_PROVIDER],
})
export class ShippingModule {}
