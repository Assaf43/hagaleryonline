import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { israelDate } from '../invoicing/vat.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';
import type { PersonalCodeMessageData } from './templates/index.js';

interface CodeJob {
  personalCodeId: number;
}

/** D.M.YYYY of the Israel calendar date of an instant. */
function displayDate(at: Date): string {
  const [y, m, d] = israelDate(at).split('-');
  return `${Number(d)}.${Number(m)}.${y}`;
}

/**
 * The outbox jobs that deliver a personal code (decisions 93–94, 96): `email.welcome_code` (website sign-up, to the
 * verified e-mail), `sms.welcome_code` (store quick account, to the verified phone), and `email.personal_code` /
 * `sms.personal_code` (issued by staff). A job carries the code's id only; the code is read here, when it is sent, so
 * it is never in a job payload. A code that is gone, already used, expired (also by its template's end, e.g. a job
 * retried late) or whose template was turned off meanwhile sends nothing; an e-mail job for an account whose e-mail is no longer verified (or gone) is skipped.
 */
@Injectable()
export class PersonalCodeMessagesJob implements OnModuleInit {
  private readonly logger = new Logger(PersonalCodeMessagesJob.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register<CodeJob>('email.welcome_code', (p) => this.send(p, 'email', 'welcome_code'));
    this.outbox.register<CodeJob>('sms.welcome_code', (p) => this.send(p, 'sms', 'welcome_code'));
    this.outbox.register<CodeJob>('email.personal_code', (p) => this.send(p, 'email', 'personal_code'));
    this.outbox.register<CodeJob>('sms.personal_code', (p) => this.send(p, 'sms', 'personal_code'));
  }

  async send(
    { personalCodeId }: CodeJob,
    channel: 'email' | 'sms',
    template: 'welcome_code' | 'personal_code',
  ): Promise<void> {
    const row = await this.prisma.personalCode.findUnique({
      where: { id: personalCodeId },
      include: {
        promotion: { select: { name: true, active: true, endsAt: true } },
        customer: { select: { fullName: true, phone: true, email: true, emailVerifiedAt: true } },
      },
    });
    if (!row || row.orderId !== null || !row.promotion.active) {
      this.logger.log(`Personal code ${personalCodeId} is gone, used or void: no message`);
      return;
    }
    const { promotion, customer } = row;
    const expiresAt = promotion.endsAt && promotion.endsAt < row.expiresAt ? promotion.endsAt : row.expiresAt;
    if (expiresAt <= new Date()) {
      this.logger.log(`Personal code ${personalCodeId} has expired: no message`);
      return;
    }
    const data: PersonalCodeMessageData = {
      customerName: customer.fullName,
      code: row.code,
      labelHe: promotion.name,
      expiresOn: displayDate(expiresAt),
      link: `${this.notifications.siteUrl()}/account/benefits`,
    };
    if (channel === 'sms') {
      await this.notifications.sms(template, customer.phone, data);
      return;
    }
    // The account's own verified address only: an e-mail released or changed meanwhile is not this account's any more.
    if (!customer.email || !customer.emailVerifiedAt) {
      this.logger.warn(`Personal code ${personalCodeId}: the account has no verified e-mail, the e-mail is skipped`);
      return;
    }
    await this.notifications.email(template, customer.email, data);
  }
}
