import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Response } from 'express';
import type { SupportTicketCreated } from '@hg/models';
import { safeEqual } from '../auth/crypto.js';
import { normalizePhone } from '../customers/contact-normalize.js';
import { OrderStatus, SupportTicketType, type Customer, type Prisma } from '../generated/prisma/client.js';
import { lookupMiss, lookupNumberText, lookupThrottleKey } from '../orders/order-lookup.service.js';
import { parseOrderNumber } from '../orders/order-number.js';
import { tooManyRequests, WriteThrottle } from '../orders/write-throttle.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { preparePhotos, SupportAttachments, type UploadedPhoto } from './attachments.js';
import {
  matchLines,
  notDelivered,
  parseContactInput,
  parseDamagedInput,
  parseReturnInput,
  DEFAULT_RETURN_WINDOW_DAYS,
  returnWindowPassed,
  supportField,
  withinReturnWindow,
  type OrderRefInput,
} from './support-input.js';

/**
 * Stand-ins of the same length as a stored phone (05XXXXXXXX), never equal to each other or to a real phone: the
 * compare runs even with no order or no valid phone, as in "my order status" (order-lookup.service).
 */
const NO_ORDER_PHONE = '----------';
const NO_GIVEN_PHONE = '__________';

/**
 * A new ticket: the type, what it is about and the contact snapshot. A ticket about an order belongs to the order's
 * account (`order.customerId`, null for a guest order); a contact ticket (its order number is not verified) takes the
 * signed-in customer, or null.
 */
export interface NewTicket {
  id?: string;
  type: SupportTicketType;
  orderId: string | null;
  customerId: string | null;
  fullName: string;
  phone: string;
  email: string;
  subject?: string | null;
  message?: string | null;
  reasonCode?: string | null;
  items?: { orderItemId: number; quantity?: number }[];
}

/** The order's contact snapshot `{ fullName, phone, email }` (checkout), as plain strings. */
export function orderContact(contact: unknown): { fullName: string; phone: string; email: string } {
  const c = (typeof contact === 'object' && contact !== null ? contact : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return { fullName: str(c.fullName), phone: str(c.phone), email: str(c.email) };
}

const orderSelect = {
  id: true,
  number: true,
  status: true,
  deliveredAt: true,
  contact: true,
  customerId: true,
  items: { select: { id: true, quantity: true } },
} satisfies Prisma.OrderSelect;
type SupportOrder = Prisma.OrderGetPayload<{ select: typeof orderSelect }>;

/**
 * Support requests (spec §7.1, SRV-02, SRV-03, SRV-05). The order of a request is found as in "my order status":
 * signed out by number + phone, signed in among the customer's own orders; every miss is the same 404. Requests
 * about an order also count per order number (`support_order`), before the order is read, so a phone cannot be
 * guessed through. A ticket and its two e-mails (to the customer, and the alert to `SUPPORT_EMAIL`) are written in
 * one transaction.
 */
@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly throttle: WriteThrottle,
    private readonly attachments: SupportAttachments,
  ) {}

  /** Return or exchange: a DELIVERED order within the return window; lines of the order up to their quantities. */
  async requestReturn(raw: unknown, customer: Customer | null, res: Response): Promise<SupportTicketCreated> {
    const input = parseReturnInput(raw);
    const order = await this.findOrder(input.order, input.items[0].orderItemId, customer, res);
    if (order.status !== OrderStatus.DELIVERED || !order.deliveredAt) throw notDelivered();
    if (!withinReturnWindow(order.deliveredAt, await this.returnWindowDays())) throw returnWindowPassed();
    matchLines(input.items, order.items);
    const ticket = await this.prisma.$transaction((tx) =>
      this.open(tx, {
        type: input.type === 'return' ? SupportTicketType.RETURN : SupportTicketType.EXCHANGE,
        orderId: order.id,
        customerId: order.customerId,
        ...orderContact(order.contact),
        reasonCode: input.reasonCode,
        message: input.note,
        items: input.items,
      }),
    );
    return { ticketNumber: ticket.number };
  }

  /**
   * Damaged product: a DELIVERED order (no day limit), one of its lines, a description and 1–5 photos. The photos
   * are checked and converted only after the order matched, then written to private storage before the ticket; if
   * the ticket cannot be saved they are deleted again.
   */
  async reportDamaged(
    raw: unknown,
    files: UploadedPhoto[] | undefined,
    customer: Customer | null,
    res: Response,
  ): Promise<SupportTicketCreated> {
    const input = parseDamagedInput(raw);
    const order = await this.findOrder(input.order, input.orderItemId, customer, res);
    if (order.status !== OrderStatus.DELIVERED) throw notDelivered();
    if (!order.items.some((i) => i.id === input.orderItemId)) throw supportField('orderItemId');
    const photos = await preparePhotos(files);

    const id = randomUUID();
    const stored = await this.attachments.store(id, photos);
    try {
      const ticket = await this.prisma.$transaction(async (tx) => {
        const created = await this.open(tx, {
          id,
          type: SupportTicketType.DAMAGED,
          orderId: order.id,
          customerId: order.customerId,
          ...orderContact(order.contact),
          message: input.description,
          items: [{ orderItemId: input.orderItemId }],
        });
        await tx.ticketAttachment.createMany({ data: stored.map((p) => ({ ticketId: id, ...p })) });
        return created;
      });
      return { ticketNumber: ticket.number };
    } catch (error) {
      await this.attachments.remove(stored);
      throw error;
    }
  }

  /**
   * The contact form. An order number that exists links the ticket to that order for staff; one that does not is
   * not reported back (the answer is the same either way), so the form tells nothing about orders.
   */
  async contact(raw: unknown, customer: Customer | null): Promise<SupportTicketCreated> {
    const input = parseContactInput(raw);
    const order =
      input.orderNumber === null
        ? null
        : await this.prisma.order.findUnique({
            where: { number: input.orderNumber },
            select: { id: true, customerId: true },
          });
    const ticket = await this.prisma.$transaction((tx) =>
      this.open(tx, {
        type: SupportTicketType.CONTACT,
        orderId: order?.id ?? null,
        // The typed order number is not verified: the ticket belongs to the session customer only, never to the
        // typed order's owner.
        customerId: customer?.id ?? null,
        fullName: input.fullName,
        phone: input.phone,
        email: input.email,
        subject: input.subject,
        message: input.message,
      }),
    );
    return { ticketNumber: ticket.number };
  }

  /**
   * Opens a ticket inside `tx` and queues its e-mails: `email.ticket_received:<id>` to the customer and
   * `email.ticket_alert:<id>` to the business inbox. Also used by the delivery link's change request.
   */
  async open(tx: Prisma.TransactionClient, ticket: NewTicket): Promise<{ id: string; number: number }> {
    const created = await tx.supportTicket.create({
      data: {
        id: ticket.id,
        type: ticket.type,
        orderId: ticket.orderId,
        customerId: ticket.customerId,
        fullName: ticket.fullName,
        phone: ticket.phone,
        email: ticket.email,
        subject: ticket.subject ?? null,
        message: ticket.message ?? null,
        reasonCode: ticket.reasonCode ?? null,
        ...(ticket.items ? { items: ticket.items } : {}),
      },
      select: { id: true, number: true },
    });
    const payload = { ticketId: created.id };
    await this.outbox.enqueue(tx, {
      type: 'email.ticket_received',
      dedupeKey: `email.ticket_received:${created.id}`,
      payload,
    });
    await this.outbox.enqueue(tx, {
      type: 'email.ticket_alert',
      dedupeKey: `email.ticket_alert:${created.id}`,
      payload,
    });
    return created;
  }

  /**
   * The order of a request, or the one 404 `lookupMiss()`. With a typed number + phone (signed in or out) both must
   * match, compared in constant time. Signed in without a phone: the typed number, or (none typed) the order of the
   * first line, and it must be the customer's. Signed out without a reference: 400 `order`.
   */
  private async findOrder(
    ref: OrderRefInput | null,
    lineId: number,
    customer: Customer | null,
    res: Response,
  ): Promise<SupportOrder> {
    if (ref) this.countOrder(lookupThrottleKey(ref.number), res);
    const number = ref ? parseOrderNumber(lookupNumberText(ref.number)) : null;

    // A signed-in caller who sends number + phone is matched exactly like a signed-out one (a guest order placed
    // before sign-up; nothing links it to the account, decision 77). Without a phone the session decides.
    const typedPhone = ref !== null && ref.phone.trim() !== '';
    if (customer && !typedPhone) {
      const order = ref
        ? await this.prisma.order.findUnique({ where: { number: number ?? 0 }, select: orderSelect })
        : ((
            await this.prisma.orderItem.findUnique({
              where: { id: lineId },
              select: { order: { select: orderSelect } },
            })
          )?.order ?? null);
      if (!ref && order) this.countOrder(String(order.number), res);
      if (!order || order.customerId !== customer.id) throw lookupMiss();
      return order;
    }

    if (!ref) throw supportField('order');
    const phone = normalizePhone(ref.phone);
    const order = await this.prisma.order.findUnique({ where: { number: number ?? 0 }, select: orderSelect });
    const stored = order ? orderContact(order.contact).phone || null : null;
    const same = safeEqual(phone ?? NO_GIVEN_PHONE, stored ?? NO_ORDER_PHONE);
    if (!order || !same) throw lookupMiss();
    return order;
  }

  /** Counts a request against its order number (`support_order`); 429 over the limit. */
  private countOrder(key: string, res: Response): void {
    if (!this.throttle.allow('support_order', key)) throw tooManyRequests(res);
  }

  private async returnWindowDays(): Promise<number> {
    const settings = await this.prisma.storeSettings.findUnique({ where: { id: 1 } });
    return settings?.returnWindowDays ?? DEFAULT_RETURN_WINDOW_DAYS;
  }
}
