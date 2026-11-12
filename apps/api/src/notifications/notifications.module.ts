import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { selectProvider } from '../providers/select-provider.js';
import { MockNotificationProvider } from './mock-notification.provider.js';
import { EMAIL_PROVIDER, SMS_PROVIDER, type EmailProvider, type SmsProvider } from './notification-provider.js';
import { NotificationsAdminController } from './notifications-admin.controller.js';
import { NotificationsService } from './notifications.service.js';
import { OrderMessagesJob } from './order-messages.job.js';

/**
 * E-mail and SMS (spec §5.2). The active adapters come from `EMAIL_PROVIDER` and `SMS_PROVIDER` (both required, no
 * default); adapters are built only when selected, so the mock refusal to run in production stops the API only
 * when it is the one configured. The outbox handlers of the order e-mails are registered here.
 */
@Module({
  imports: [AuthModule, OutboxModule],
  controllers: [NotificationsAdminController],
  providers: [
    NotificationsService,
    OrderMessagesJob,
    {
      provide: EMAIL_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): EmailProvider =>
        selectProvider<EmailProvider>('EMAIL_PROVIDER', config.get<string>('EMAIL_PROVIDER'), {
          mock: () => new MockNotificationProvider(config),
        }),
    },
    {
      provide: SMS_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): SmsProvider =>
        selectProvider<SmsProvider>('SMS_PROVIDER', config.get<string>('SMS_PROVIDER'), {
          mock: () => new MockNotificationProvider(config),
        }),
    },
  ],
  exports: [NotificationsService, EMAIL_PROVIDER, SMS_PROVIDER],
})
export class NotificationsModule {}
