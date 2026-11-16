import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { resolveOtpPepper } from '../customers/otp.service.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { MarketingMessagesJob } from './marketing-messages.job.js';
import { UnsubscribeTokens } from './marketing-tokens.js';
import { MarketingService } from './marketing.service.js';

/**
 * Marketing consent (Phase 7, spec §5.3, decisions 95–96): `MarketingService` is the only writer of marketing contacts
 * and their history; the confirmation messages run as outbox jobs (`MarketingMessagesJob`). The unsubscribe tokens
 * are an HMAC under `OTP_PEPPER` (the server secret already required in production), with their own prefix.
 */
@Module({
  imports: [OutboxModule, NotificationsModule],
  providers: [
    MarketingService,
    MarketingMessagesJob,
    {
      provide: UnsubscribeTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new UnsubscribeTokens(resolveOtpPepper(config.get<string>('OTP_PEPPER'), config.get<string>('NODE_ENV'))),
    },
  ],
  exports: [MarketingService],
})
export class MarketingModule {}
