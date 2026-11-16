import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { MarketingStatus } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  CONFIRM_TTL_MS,
  confirmLink,
  newConfirmToken,
  UnsubscribeTokens,
  unsubscribeLink,
} from './marketing-tokens.js';

interface ConfirmJob {
  contactId: string;
}
interface StoreConsentJob extends ConfirmJob {
  phone: string;
}

/**
 * The confirmation messages of `MarketingService.requestConfirmation` (decisions 95–96): `email.newsletter_confirm`
 * (the confirm link and the unsubscribe link) and `sms.store_consent` (the confirm link, to the store customer's
 * phone). While the contact is still `pending`, each run makes a new random confirmation token valid 7 days — only
 * its hash is stored, so a newer message (or a retried job) retires the older link — and writes the contact's stable
 * unsubscribe hash. A contact no longer pending (confirmed, withdrawn or released meanwhile) gets nothing.
 */
@Injectable()
export class MarketingMessagesJob implements OnModuleInit {
  private readonly logger = new Logger(MarketingMessagesJob.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly tokens: UnsubscribeTokens,
  ) {}

  onModuleInit(): void {
    this.outbox.register<ConfirmJob>('email.newsletter_confirm', (p) => this.newsletterConfirm(p));
    this.outbox.register<StoreConsentJob>('sms.store_consent', (p) => this.storeConsent(p));
  }

  async newsletterConfirm({ contactId }: ConfirmJob): Promise<void> {
    const links = await this.issue(contactId);
    if (!links) return;
    await this.notifications.email('newsletter_confirm', links.email, {
      confirmUrl: links.confirmUrl,
      unsubscribeUrl: links.unsubscribeUrl,
    });
  }

  async storeConsent({ contactId, phone }: StoreConsentJob): Promise<void> {
    const links = await this.issue(contactId);
    if (!links) return;
    await this.notifications.sms('store_consent', phone, { url: links.confirmUrl });
  }

  private async issue(contactId: string) {
    const contact = await this.prisma.marketingContact.findUnique({ where: { id: contactId } });
    if (!contact || contact.status !== MarketingStatus.PENDING) {
      this.logger.log(`Marketing contact ${contactId} is no longer pending: no confirmation message`);
      return null;
    }
    const { token, hash } = newConfirmToken();
    // Only a still-pending contact gets the token, so one confirmed or withdrawn a moment ago keeps its state.
    const updated = await this.prisma.marketingContact.updateMany({
      where: { id: contactId, status: MarketingStatus.PENDING },
      data: {
        confirmTokenHash: hash,
        confirmExpiresAt: new Date(Date.now() + CONFIRM_TTL_MS),
        unsubscribeTokenHash: this.tokens.hash(contactId),
      },
    });
    if (updated.count === 0) return null;
    const site = this.notifications.siteUrl();
    return {
      email: contact.email,
      confirmUrl: confirmLink(site, token),
      unsubscribeUrl: unsubscribeLink(site, this.tokens.token(contactId)),
    };
  }
}
