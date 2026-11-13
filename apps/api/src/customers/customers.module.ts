import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { WriteThrottleModule } from '../orders/write-throttle.module.js';
import { WriteThrottle } from '../orders/write-throttle.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CustomerAuthController } from './customer-auth.controller.js';
import { CustomerAuthService } from './customer-auth.service.js';
import { CustomerSessionService } from './customer-session.service.js';
import { CustomerCookie, CustomerSessionGuard, OptionalCustomerGuard } from './customer-session.guard.js';
import { PrismaOtpStore } from './otp-store.prisma.js';
import { OtpService, resolveOtpPepper } from './otp.service.js';

/**
 * Customers & Auth (Phase 5c, spec §6.1, §6.2): accounts, one-time codes, sessions. Codes go out directly through
 * `NotificationsService` (template `otp`), not through the outbox. Exports the session guards for cart and checkout.
 */
@Module({
  imports: [AuthModule, NotificationsModule, WriteThrottleModule],
  controllers: [CustomerAuthController],
  providers: [
    CustomerSessionService,
    CustomerCookie,
    CustomerSessionGuard,
    OptionalCustomerGuard,
    CustomerAuthService,
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
  exports: [CustomerSessionService, CustomerCookie, CustomerSessionGuard, OptionalCustomerGuard],
})
export class CustomersModule {}
