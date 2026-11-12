import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OrderStatus } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { NotificationsService } from './notifications.service.js';

interface OrderJob {
  orderId: string;
}
interface StatusJob extends OrderJob {
  status: string;
}
interface RefundJob extends OrderJob {
  refundId: string;
}

/**
 * Handlers of the outbox e-mail jobs of an order (spec §5.3, decision 83): `email.order_paid`, `email.status`
 * (shipped, delivered), `email.cancelled` and `email.refund`. Each mails the order contact e-mail with the link
 * `/order/{number}?t={publicToken}`. A provider error throws, so the outbox retries; a job may run twice after a
 * crash, which at worst sends the same e-mail twice.
 */
@Injectable()
export class OrderMessagesJob implements OnModuleInit {
  private readonly logger = new Logger(OrderMessagesJob.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.outbox.register<OrderJob>('email.order_paid', (p) => this.orderPaid(p));
    this.outbox.register<StatusJob>('email.status', (p) => this.status(p));
    this.outbox.register<OrderJob>('email.cancelled', (p) => this.cancelled(p));
    this.outbox.register<RefundJob>('email.refund', (p) => this.refund(p));
  }

  private async load(orderId: string) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    if (!order) {
      this.logger.warn(`Order ${orderId} no longer exists: its e-mail is skipped`);
      return null;
    }
    const contact = order.contact as { fullName?: string; email?: string };
    if (!contact.email) throw new Error(`Order ${order.number} has no e-mail address`);
    return {
      order,
      to: contact.email,
      base: {
        number: order.number,
        customerName: contact.fullName,
        link: `${this.notifications.siteUrl()}/order/${order.number}?t=${encodeURIComponent(order.publicToken)}`,
      },
    };
  }

  async orderPaid({ orderId }: OrderJob): Promise<void> {
    const loaded = await this.load(orderId);
    if (!loaded) return;
    const { order, to, base } = loaded;
    const estimate = order.deliveryEstimate as { fulfillment?: string; leadTimeDays?: number } | null;
    const days = estimate?.leadTimeDays ?? 0;
    await this.notifications.email(
      'order_paid',
      to,
      {
        ...base,
        lines: order.items.map((i) => ({
          modelName: i.modelName,
          nameHe: i.nameHe,
          optionLabels: i.optionLabels as string[],
          quantity: i.quantity,
          lineTotal: i.lineTotal,
        })),
        subtotal: order.subtotal,
        discount: order.discount,
        shippingTotal: order.shippingTotal,
        total: order.total,
        deliveryDays: estimate?.fulfillment !== 'out_of_stock' && days > 0 ? days : null,
      },
      order.id,
    );
  }

  async status({ orderId, status }: StatusJob): Promise<void> {
    if (status !== 'shipped' && status !== 'delivered') throw new Error(`No e-mail for status "${status}"`);
    const loaded = await this.load(orderId);
    if (!loaded) return;
    // Cancelled before the job ran: a "shipped" / "delivered" e-mail would contradict the cancel e-mail.
    if (loaded.order.status === OrderStatus.CANCELLED) {
      this.logger.log(`Order ${loaded.order.number} was cancelled: no "${status}" e-mail`);
      return;
    }
    await this.notifications.email(`status_${status}`, loaded.to, loaded.base, loaded.order.id);
  }

  async cancelled({ orderId }: OrderJob): Promise<void> {
    const loaded = await this.load(orderId);
    if (!loaded) return;
    await this.notifications.email('order_cancelled', loaded.to, loaded.base, loaded.order.id);
  }

  async refund({ orderId, refundId }: RefundJob): Promise<void> {
    const loaded = await this.load(orderId);
    if (!loaded) return;
    const refund = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { amount: true } });
    if (!refund) {
      this.logger.warn(`Refund ${refundId} no longer exists: its e-mail is skipped`);
      return;
    }
    await this.notifications.email('refund', loaded.to, { ...loaded.base, amount: refund.amount }, loaded.order.id);
  }
}
