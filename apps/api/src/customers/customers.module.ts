import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { CartModule } from '../cart/cart.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OrdersModule } from '../orders/orders.module.js';
import { WriteThrottleModule } from '../orders/write-throttle.module.js';
import { WriteThrottle } from '../orders/write-throttle.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { AccountController } from './account.controller.js';
import { AccountService } from './account.service.js';
import { CustomerAuthController } from './customer-auth.controller.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CustomerCleanupService } from './customer-cleanup.service.js';
import { CustomerSessionModule } from './customer-session.module.js';
import { PrismaOtpStore } from './otp-store.prisma.js';
import { OtpService, resolveOtpPepper } from './otp.service.js';

/**
 * Customers & Auth (Phase 5c, spec §6.1–§6.3): accounts, one-time codes, sign-in (with the cart merge) and the
 * account's own data. Codes go out directly through `NotificationsService` (template `otp`), not through the outbox.
 * The session and its guards live in `CustomerSessionModule`, which the cart and checkout import too.
 */
@Module({
  imports: [AuthModule, CartModule, CustomerSessionModule, NotificationsModule, OrdersModule, WriteThrottleModule],
  controllers: [CustomerAuthController, AccountController],
  providers: [
    CustomerAuthService,
    AccountService,
    CustomerCleanupService,
    {
      provide: OtpService,
      inject: [PrismaService, NotificationsService, WriteThrottle, ConfigService],
      useFactory: (
        prisma: PrismaService,
        notifications: NotificationsService,
        throttle: WriteThrottle,
        config: ConfigService,
      ) =>
        new OtpService(
          new PrismaOtpStore(prisma),
          {
            send: (channel, target, code) =>
              channel === 'email'
                ? notifications.email('otp', target, { code })
                : notifications.sms('otp', target, { code }),
          },
          { allow: (ip) => throttle.allow('otp', ip) },
          resolveOtpPepper(config.get<string>('OTP_PEPPER'), config.get<string>('NODE_ENV')),
        ),
    },
  ],
})
export class CustomersModule {}
