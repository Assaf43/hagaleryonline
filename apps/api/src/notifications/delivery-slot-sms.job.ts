import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { hashToken, randomToken } from '../auth/crypto.js';
import { DeliverySlotState } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

interface SlotJob {
  orderId: string;
  slotId: number;
}

/**
 * The outbox job `sms.delivery_slot` (spec §5.3, SHP-04): while the slot is still PROPOSED it gets a new random
 * token (only the hash is stored) and the customer is sent the link `{SITE_URL}/delivery/{token}`. A slot that was
 * superseded or answered meanwhile sends nothing. A retried job makes a new token, so an older SMS link stops working.
 */
@Injectable()
export class DeliverySlotSmsJob implements OnModuleInit {
  private readonly logger = new Logger(DeliverySlotSmsJob.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register<SlotJob>('sms.delivery_slot', (p) => this.send(p));
  }

  async send({ slotId }: SlotJob): Promise<void> {
    const slot = await this.prisma.deliverySlot.findUnique({
      where: { id: slotId },
      include: { order: { select: { id: true, number: true, contact: true } } },
    });
    if (!slot || slot.state !== DeliverySlotState.PROPOSED) {
      this.logger.log(`Delivery slot ${slotId} is no longer proposed: no SMS`);
      return;
    }
    const phone = (slot.order.contact as { phone?: string }).phone;
    if (!phone) throw new Error(`Order ${slot.order.number} has no phone number`);
    const token = randomToken();
    // Only a still-proposed slot gets the token, so a slot answered a moment ago keeps its state.
    const updated = await this.prisma.deliverySlot.updateMany({
      where: { id: slot.id, state: DeliverySlotState.PROPOSED },
      data: { tokenHash: hashToken(token) },
    });
    if (updated.count === 0) return;
    const [y, m, d] = slot.date.toISOString().slice(0, 10).split('-');
    await this.notifications.sms(
      'delivery_slot',
      phone,
      {
        number: slot.order.number,
        date: `${Number(d)}.${Number(m)}.${y}`,
        from: slot.windowFrom,
        to: slot.windowTo,
        url: `${this.notifications.siteUrl()}/delivery/${token}`,
      },
      slot.order.id,
    );
  }
}
