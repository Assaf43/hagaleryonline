import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuthModule } from '../auth/auth.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { WriteThrottleModule } from '../orders/write-throttle.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { selectProvider } from '../providers/select-provider.js';
import { MarketingDevController } from './marketing-dev.controller.js';
import { MarketingMessagesJob } from './marketing-messages.job.js';
import { MARKETING_PROVIDER, type MarketingProvider } from './marketing-provider.js';
import { MarketingSyncJob } from './marketing-sync.job.js';
import { resolveMarketingTokenSecret, UnsubscribeTokens } from './marketing-tokens.js';
import { MarketingWebhookController } from './marketing-webhook.controller.js';
import { MarketingService } from './marketing.service.js';
import { MockMarketingProvider } from './mock-marketing.provider.js';
import { NewsletterController } from './newsletter.controller.js';

/**
 * Marketing consent and the e-mail tool (Phase 7, spec §5.3–5.4, CLB-11, decisions 95–96): `MarketingService` is the
 * only writer of marketing contacts and their history; the confirmation messages (`MarketingMessagesJob`) and the
 * sync to the tool (`MarketingSyncJob`) run as outbox jobs. The active `MarketingProvider` comes from
 * `MARKETING_PROVIDER` (required, no default; only `mock`, which refuses production). The tool reports unsubscribes to
 * `POST /api/marketing/webhook`. The unsubscribe tokens are an HMAC under `MARKETING_TOKEN_SECRET` (required in
 * production).
 */
@Module({
  imports: [AuthModule, OutboxModule, NotificationsModule, WriteThrottleModule],
  controllers: [MarketingWebhookController, MarketingDevController, NewsletterController],
  providers: [
    MarketingService,
    MarketingMessagesJob,
    MarketingSyncJob,
    {
      provide: UnsubscribeTokens,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        new UnsubscribeTokens(
          resolveMarketingTokenSecret(config.get<string>('MARKETING_TOKEN_SECRET'), config.get<string>('NODE_ENV')),
        ),
    },
    {
      provide: MARKETING_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MarketingProvider =>
        selectProvider<MarketingProvider>('MARKETING_PROVIDER', config.get<string>('MARKETING_PROVIDER'), {
          mock: () => new MockMarketingProvider(config),
        }),
    },
  ],
  exports: [MarketingService],
})
export class MarketingModule {}
