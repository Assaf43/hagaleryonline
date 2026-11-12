import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AdminSentMessage } from '@hg/models';
import { NotificationChannel, NotificationStatus, type Prisma } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { maskEmail, maskPhone } from './masking.js';
import { resolveSiteUrl } from './site-url.js';
import { MOCK_CODE } from './mock-notification.provider.js';
import { EMAIL_PROVIDER, SMS_PROVIDER, type EmailProvider, type SmsProvider } from './notification-provider.js';
import {
  renderEmail,
  renderSms,
  type EmailTemplate,
  type EmailTemplateData,
  type SmsTemplate,
  type SmsTemplateData,
} from './templates/index.js';

const VIEWER_LIMIT = 100;

interface Entry {
  channel: NotificationChannel;
  template: string;
  provider: string;
  recipientMasked: string;
  orderId?: string;
  subject: string | null;
  body: string;
}

/**
 * Renders a Hebrew template, sends it through the active provider and logs it (spec §5.2). A provider error is
 * logged as a `failed` row and rethrown, so the outbox job retries. Only the masked recipient is stored; the
 * subject and the full body are kept only while the provider is the `mock` (the dev viewer).
 */
@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);
  private readonly site: string;

  constructor(
    @Inject(EMAIL_PROVIDER) private readonly emailProvider: EmailProvider,
    @Inject(SMS_PROVIDER) private readonly smsProvider: SmsProvider,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    // Resolved once: a missing address in production stops the API at startup (see resolveSiteUrl).
    this.site = resolveSiteUrl(config);
  }

  /** The public site address, without a trailing slash (links in messages). */
  siteUrl(): string {
    return this.site;
  }

  async email<T extends EmailTemplate>(
    template: T,
    to: string,
    data: EmailTemplateData[T],
    orderId?: string,
  ): Promise<void> {
    const message = renderEmail(template, data);
    const provider = this.emailProvider;
    const from = this.config.get<string>('EMAIL_FROM') || undefined;
    await this.deliver(
      {
        channel: NotificationChannel.EMAIL,
        template,
        provider: provider.code,
        recipientMasked: maskEmail(to),
        orderId,
        subject: message.subject,
        body: message.html,
      },
      () => provider.sendEmail({ to, from, subject: message.subject, html: message.html, text: message.text }),
    );
  }

  async sms<T extends SmsTemplate>(template: T, to: string, data: SmsTemplateData[T], orderId?: string): Promise<void> {
    const text = renderSms(template, data);
    const provider = this.smsProvider;
    await this.deliver(
      {
        channel: NotificationChannel.SMS,
        template,
        provider: provider.code,
        recipientMasked: maskPhone(to),
        orderId,
        subject: null,
        body: text,
      },
      () => provider.sendSms({ to, text }),
    );
  }

  /** True only while both active providers are the mock: the dev viewer exists then and nowhere else. */
  devViewerEnabled(): boolean {
    return this.emailProvider.code === MOCK_CODE && this.smsProvider.code === MOCK_CODE;
  }

  /** The last 100 messages, newest first, with their bodies (mock only). */
  async recent(): Promise<AdminSentMessage[]> {
    const rows = await this.prisma.notificationLog.findMany({
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: VIEWER_LIMIT,
      include: { order: { select: { number: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      channel: r.channel === NotificationChannel.EMAIL ? 'email' : 'sms',
      recipientMasked: r.recipientMasked,
      template: r.template,
      provider: r.provider,
      status: r.status === NotificationStatus.SENT ? 'sent' : 'failed',
      orderNumber: r.order?.number ?? null,
      createdAt: r.createdAt.toISOString(),
      subject: r.subject,
      body: r.body,
    }));
  }

  private async deliver(entry: Entry, send: () => Promise<{ messageId: string }>): Promise<void> {
    const keepBody = entry.provider === MOCK_CODE;
    const row = {
      channel: entry.channel,
      template: entry.template,
      provider: entry.provider,
      recipientMasked: entry.recipientMasked,
      orderId: entry.orderId ?? null,
      subject: keepBody ? entry.subject : null,
      body: keepBody ? entry.body : null,
    };
    let messageId: string;
    try {
      ({ messageId } = await send());
    } catch (error) {
      await this.log({ ...row, status: NotificationStatus.FAILED, providerMessageId: null });
      throw error;
    }
    // The message is out: a log failure must not make the job send it again.
    await this.log({ ...row, status: NotificationStatus.SENT, providerMessageId: messageId });
  }

  private async log(data: Prisma.NotificationLogUncheckedCreateInput): Promise<void> {
    await this.prisma.notificationLog
      .create({ data })
      .catch((error: unknown) => this.logger.error('Could not write the notification log', error));
  }
}
