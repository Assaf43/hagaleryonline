import type { ConfigService } from '@nestjs/config';
import { SupportTicketType } from '../generated/prisma/client.js';
import type { NotificationsService } from '../notifications/notifications.service.js';
import type { OutboxService } from '../outbox/outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { TicketMessagesJob } from './ticket-messages.job.js';

const TICKET = {
  id: 't-1',
  number: 5001,
  type: SupportTicketType.DAMAGED,
  email: 'dana@example.test',
  fullName: 'דנה',
  orderId: 'o-1',
  order: { number: 100123 },
};

function job(supportEmail: string | undefined, ticket: Partial<typeof TICKET> = {}) {
  const email = vi.fn().mockResolvedValue(undefined);
  const prisma = {
    supportTicket: { findUnique: vi.fn().mockResolvedValue({ ...TICKET, ...ticket }) },
  } as unknown as PrismaService;
  const config = { get: () => supportEmail } as unknown as ConfigService;
  const outbox = { register: vi.fn() } as unknown as OutboxService;
  const notifications = { email } as unknown as NotificationsService;
  return { job: new TicketMessagesJob(outbox, prisma, notifications, config), email };
}

describe('TicketMessagesJob', () => {
  it('sends the alert to SUPPORT_EMAIL with the number, type and order', async () => {
    const { job: j, email } = job(' support@example.test ');
    await j.alert({ ticketId: 't-1' });
    expect(email).toHaveBeenCalledWith(
      'ticket_alert',
      'support@example.test',
      { ticketNumber: 5001, type: 'damaged', orderNumber: 100123 },
      'o-1',
    );
  });

  it.each([undefined, '', '   '])('SUPPORT_EMAIL %o: the alert is skipped and the job finishes', async (value) => {
    const { job: j, email } = job(value);
    await expect(j.alert({ ticketId: 't-1' })).resolves.toBeUndefined();
    expect(email).not.toHaveBeenCalled();
  });

  it('sends the confirmation to the ticket e-mail; an empty one finishes the job without sending', async () => {
    const sent = job('support@example.test');
    await sent.job.received({ ticketId: 't-1' });
    expect(sent.email).toHaveBeenCalledWith(
      'ticket_received',
      'dana@example.test',
      { ticketNumber: 5001, customerName: 'דנה' },
      'o-1',
    );
    const empty = job('support@example.test', { email: '' });
    await expect(empty.job.received({ ticketId: 't-1' })).resolves.toBeUndefined();
    expect(empty.email).not.toHaveBeenCalled();
  });
});
