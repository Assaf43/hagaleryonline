import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { CatalogModule } from '../catalog/catalog.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PAYMENT_PROVIDER, selectPaymentProvider } from '../payments/payment-provider.js';
import { PaymentsController } from '../payments/payments.controller.js';
import { PaymentsService } from '../payments/payments.service.js';
import { SandboxPaymentProvider } from '../payments/sandbox-payment.provider.js';
import { HttpWebhookDispatcher, WebhookDispatcher } from '../payments/webhook-dispatcher.js';
import { PromotionsModule } from '../promotions/promotions.module.js';
import { ShippingModule } from '../shipping/shipping.module.js';
import { DeliverySlotController } from './delivery-slot.controller.js';
import { DeliverySlotService } from './delivery-slot.service.js';
import { CheckoutController } from './checkout.controller.js';
import { CheckoutService } from './checkout.service.js';
import { LatePaymentRefundJob } from './late-payment.job.js';
import { OrderLifecycleService } from './order-lifecycle.service.js';
import { RefundService } from './refund.service.js';
import { OrdersAdminController } from './orders-admin.controller.js';
import { OrdersAdminService } from './orders-admin.service.js';
import { OrdersController } from './orders.controller.js';
import { OrdersService } from './orders.service.js';
import { WriteThrottleModule } from './write-throttle.module.js';

/**
 * Checkout, orders and payments (spec §5). The active `PaymentProvider` comes from `PAYMENT_PROVIDER` (required, no
 * default); adapters are built only when selected, so the sandbox's refusal to run in production or on a public site
 * address stops the API only when it is the configured provider.
 */
@Module({
  imports: [AuthModule, CatalogModule, CartModule, PromotionsModule, ShippingModule, WriteThrottleModule, OutboxModule],
  controllers: [
    DeliverySlotController,
    CheckoutController,
    OrdersController,
    PaymentsController,
    OrdersAdminController,
  ],
  providers: [
    CheckoutService,
    OrdersService,
    OrdersAdminService,
    OrderLifecycleService,
    DeliverySlotService,
    RefundService,
    LatePaymentRefundJob,
    PaymentsService,
    { provide: WebhookDispatcher, useClass: HttpWebhookDispatcher },
    {
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        selectPaymentProvider(config.get<string>('PAYMENT_PROVIDER'), {
          sandbox: () => new SandboxPaymentProvider(config),
        }),
    },
  ],
  exports: [PAYMENT_PROVIDER, PaymentsService],
})
export class OrdersModule {}
