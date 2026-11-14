import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SupportTicketType as TicketTypeCode } from '@hg/models';
import { SupportTicketType } from '../generated/prisma/client.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';

interface TicketJob {
  ticketId: string;
}

const TYPE_CODE: Record<SupportTicketType, TicketTypeCode> = {
  [SupportTicketType.RETURN]: 'return',
  [SupportTicketType.EXCHANGE]: 'exchange',
  [SupportTicketType.DAMAGED]: 'damaged',
  [SupportTicketType.CONTACT]: 'contact',
  [SupportTicketType.DELIVERY_CHANGE]: 'delivery_change',
};

/**
 * Handlers of the ticket e-mails (spec §7.1): `email.ticket_received` to the ticket's contact e-mail, and
 * `email.ticket_alert` to the business inbox `SUPPORT_EMAIL` (read once; without it the alert is skipped with a
 * warning, it is not required at startup). A missing recipient finishes the job with a warning (a retry cannot fix
 * it); a provider error throws, so the outbox retries.
 */
@Injectable()
export class TicketMessagesJob implements OnModuleInit {
  private readonly logger = new Logger(TicketMessagesJob.name);
  private readonly supportEmail: string | null;

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    config: ConfigService,
  ) {
    this.supportEmail = config.get<string>('SUPPORT_EMAIL')?.trim() || null;
  }

  onModuleInit(): void {
    this.outbox.register<TicketJob>('email.ticket_received', (p) => this.received(p));
    this.outbox.register<TicketJob>('email.ticket_alert', (p) => this.alert(p));
  }

  private async load(ticketId: string) {
    const ticket = await this.prisma.supportTicket.findUnique({
      where: { id: ticketId },
      include: { order: { select: { number: true } } },
    });
    if (!ticket) this.logger.warn(`Ticket ${ticketId} no longer exists: its e-mail is skipped`);
    return ticket;
  }

  async received({ ticketId }: TicketJob): Promise<void> {
    const ticket = await this.load(ticketId);
    if (!ticket) return;
    // Retrying cannot give a ticket an address: finish the job instead of failing it eight times.
    if (!ticket.email.trim()) {
      this.logger.warn(`Ticket ${ticket.number} has no e-mail address: no confirmation e-mail`);
      return;
    }
    await this.notifications.email(
      'ticket_received',
      ticket.email,
      { ticketNumber: ticket.number, customerName: ticket.fullName },
      ticket.orderId ?? undefined,
    );
  }

  async alert({ ticketId }: TicketJob): Promise<void> {
    const ticket = await this.load(ticketId);
    if (!ticket) return;
    if (!this.supportEmail) {
      this.logger.warn(`SUPPORT_EMAIL is not set: no alert for ticket ${ticket.number}`);
      return;
    }
    await this.notifications.email(
      'ticket_alert',
      this.supportEmail,
      { ticketNumber: ticket.number, type: TYPE_CODE[ticket.type], orderNumber: ticket.order?.number ?? null },
      ticket.orderId ?? undefined,
    );
  }
}
