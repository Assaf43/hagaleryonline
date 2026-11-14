import { HttpStatus, Injectable } from '@nestjs/common';
import type {
  AdminCancelRequest,
  AdminOrderDetail,
  AdminRefundRequest,
  CancelRefundChoice,
  DeliverySlotInput,
  OrderStatus as OrderStatusView,
  OrderView,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import {
  DeliverySlotState,
  FulfillmentMode,
  OrderActorType,
  OrderStatus,
  PaymentStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseSlot } from './delivery-slot.js';
import { lockOrder, lockOrderPayments, lockVariants } from './locks.js';
import { badField, CheckoutError, invalidInput, orderNotFound } from './order-errors.js';
import { parseOrderNumber } from './order-number.js';
import { canAdvance, canCancel } from './order-transitions.js';
import { parseAmount, parseReason } from './refund-amount.js';
import { RefundService } from './refund.service.js';
import { OrdersAdminService } from './orders-admin.service.js';
import { effectiveStatus, OrdersService, STATUS_VIEW, type OrderAccess } from './orders.service.js';

const STATUS_FROM_VIEW = new Map<string, OrderStatus>(
  (Object.entries(STATUS_VIEW) as [OrderStatus, OrderStatusView][]).map(([prisma, view]) => [view, prisma]),
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REFUND_CHOICES: readonly CancelRefundChoice[] = ['full', 'partial', 'none'];

const invalidTransition = () => new CheckoutError(HttpStatus.CONFLICT, 'invalid_transition');

export interface LifecycleActor {
  adminId: number;
  ip?: string;
}

/** Status moves by staff and the customer's cancel of an unpaid order (spec §4.1, §4.2, ADM-04, SRV-01). */
@Injectable()
export class OrderLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly adminOrders: OrdersAdminService,
    private readonly orders: OrdersService,
    private readonly refunds: RefundService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Moves an order forward (spec §4.1) under the order lock. `delivery_scheduled` needs `slot`; the order's previous
   * slot is superseded first (the database allows one live slot). An order already `delivery_scheduled` may be sent
   * `delivery_scheduled` again with a new slot: that changes the slot only.
   */
  async advance(
    numberParam: string,
    to: OrderStatusView,
    actor: LifecycleActor,
    slotRaw?: unknown,
  ): Promise<AdminOrderDetail> {
    const number = parseOrderNumber(numberParam);
    if (number === null) throw orderNotFound();
    const target = STATUS_FROM_VIEW.get(to);
    if (!target) throw invalidInput();
    const slot = target === OrderStatus.DELIVERY_SCHEDULED ? parseSlot(slotRaw) : undefined;

    const found = await this.prisma.order.findUnique({ where: { number }, select: { id: true } });
    if (!found) throw orderNotFound();
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, found.id);
      const order = await tx.order.findUniqueOrThrow({ where: { id: found.id } });
      const from = order.status;
      const slotChange = from === OrderStatus.DELIVERY_SCHEDULED && target === from;
      if (!slotChange && !canAdvance(from, target)) throw invalidTransition();

      if (slot) await this.replaceSlot(tx, order.id, slot);
      await tx.order.update({
        where: { id: order.id },
        data: { status: target, ...(target === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}) },
      });
      await tx.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: from,
          toStatus: target,
          actorType: OrderActorType.ADMIN,
          actorAdminId: actor.adminId,
          note: slotChange ? 'delivery slot changed' : null,
        },
      });
      await this.audit.record(
        {
          actorId: actor.adminId,
          action: 'order.status',
          entityType: 'order',
          entityId: order.number,
          before: { status: STATUS_VIEW[from] },
          after: { status: STATUS_VIEW[target], ...(slot ? { slot } : {}) },
          ip: actor.ip,
        },
        tx,
      );
      await this.onStatusChanged(tx, order, from, target);
    });
    return this.adminOrders.detail(numberParam);
  }

  /**
   * POST /api/orders/:number/cancel?t= and POST /api/account/orders/:number/cancel (the account's own order) — only
   * while waiting for payment (and within the reservation). Locks the order's payments, then the order (the webhook's
   * lock order), so a payment webhook landing at the same moment either wins (the order is paid: 409) or finds the
   * payment cancelled.
   */
  async cancelByCustomer(numberParam: string, access: OrderAccess): Promise<OrderView> {
    // The 404 for an unknown number, a wrong token or another account's order is the view's.
    await this.orders.view(numberParam, access);
    const number = parseOrderNumber(numberParam)!;
    const found = await this.prisma.order.findUniqueOrThrow({ where: { number }, select: { id: true } });
    await this.prisma.$transaction(async (tx) => {
      await lockOrderPayments(tx, found.id);
      await lockOrder(tx, found.id);
      const order = await tx.order.findUniqueOrThrow({ where: { id: found.id } });
      if (!canCancel(effectiveStatus(order), 'customer')) throw invalidTransition();
      await tx.payment.updateMany({
        where: { orderId: order.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CANCELLED },
      });
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });
      await this.supersedeSlot(tx, order.id);
      await tx.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: order.status,
          toStatus: OrderStatus.CANCELLED,
          actorType: OrderActorType.CUSTOMER,
        },
      });
      await this.onStatusChanged(tx, order, order.status, OrderStatus.CANCELLED);
    });
    return this.orders.view(numberParam, access);
  }

  /**
   * POST /api/admin/orders/:number/cancel (`orders.cancel`, decisions 73–74). Everything is checked before anything
   * changes. In one transaction (payments → order → variants, the webhook's lock order) the order becomes CANCELLED,
   * every pending payment is cancelled (paid orders too), the lines go back to stock (paid orders, unless `restock` is false) and the
   * refund row is inserted PENDING; the provider is called after commit. A refund the provider refuses leaves the
   * order cancelled with a FAILED refund and the order flagged. An unpaid order has nothing to refund.
   */
  async cancelByAdmin(numberParam: string, raw: unknown, actor: LifecycleActor): Promise<AdminOrderDetail> {
    const number = parseOrderNumber(numberParam);
    if (number === null) throw orderNotFound();
    const input = parseCancel(raw);
    const found = await this.prisma.order.findUnique({ where: { number }, select: { id: true } });
    if (!found) throw orderNotFound();

    const refundId = await this.prisma.$transaction(async (tx) => {
      await lockOrderPayments(tx, found.id);
      await lockOrder(tx, found.id);
      const order = await tx.order.findUniqueOrThrow({
        where: { id: found.id },
        include: { items: { select: { variantId: true, quantity: true } } },
      });
      const from = order.status;
      if (!canCancel(effectiveStatus(order), 'admin')) throw invalidTransition();
      const unpaid = from === OrderStatus.PENDING_PAYMENT;
      if (unpaid && input.refund !== 'none') throw badField('refund');

      // The refund is reserved in this transaction, so it fails here, before any change, when it does not fit.
      let reserved: { id: string; amount: number } | null = null;
      if (input.refund !== 'none') {
        const { refundable } = await this.refunds.state(tx, order.id);
        const amount = input.refund === 'full' ? refundable : input.amount!;
        // A full cancel of an order that was already refunded in full has nothing left to refund.
        if (input.refund === 'partial' || amount > 0) {
          const refund = await this.refunds.reserve(tx, order.id, amount, input.reason, actor.adminId);
          reserved = { id: refund.id, amount: refund.amount };
        }
      }

      // Every open payment page of the order is closed, paid orders included (the payment locks are held): a
      // payment that still goes through is a late payment (refunded, or flagged for a manual refund).
      await tx.payment.updateMany({
        where: { orderId: order.id, status: PaymentStatus.PENDING },
        data: { status: PaymentStatus.CANCELLED },
      });
      const restock = !unpaid && input.restock;
      if (restock) await this.restock(tx, order.items);
      await tx.order.update({
        where: { id: order.id },
        data: { status: OrderStatus.CANCELLED, cancelledAt: new Date() },
      });
      // The delivery link sent to the customer stops working with the cancel.
      await this.supersedeSlot(tx, order.id);
      await tx.orderStatusEvent.create({
        data: {
          orderId: order.id,
          fromStatus: from,
          toStatus: OrderStatus.CANCELLED,
          actorType: OrderActorType.ADMIN,
          actorAdminId: actor.adminId,
          note: input.reason,
        },
      });
      await this.audit.record(
        {
          actorId: actor.adminId,
          action: 'order.cancel',
          entityType: 'order',
          entityId: order.number,
          before: { status: STATUS_VIEW[from] },
          after: {
            status: 'cancelled',
            reason: input.reason,
            refund: input.refund,
            refundAmount: reserved?.amount ?? 0,
            restock,
          },
          ip: actor.ip,
        },
        tx,
      );
      await this.onStatusChanged(tx, order, from, OrderStatus.CANCELLED);
      return reserved?.id ?? null;
    });
    if (refundId) await this.refunds.execute(refundId, actor);
    return this.adminOrders.detail(numberParam);
  }

  /**
   * POST /api/admin/orders/:number/refunds (`orders.cancel`): a refund without cancelling. 400 `reason` / `amount`,
   * 409 `refund_exceeds_paid`. A provider failure is not an error here: the detail shows the FAILED refund.
   */
  async refundByAdmin(numberParam: string, raw: unknown, actor: LifecycleActor): Promise<AdminOrderDetail> {
    const number = parseOrderNumber(numberParam);
    if (number === null) throw orderNotFound();
    const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
      Record<keyof AdminRefundRequest, unknown>
    >;
    const reason = parseReason(body.reason);
    if (reason === null) throw badField('reason');
    const amount = parseAmount(body.amount);
    if (amount === null) throw badField('amount');
    const found = await this.prisma.order.findUnique({ where: { number }, select: { id: true } });
    if (!found) throw orderNotFound();
    await this.refunds.create(found.id, amount, reason, actor.adminId, actor.ip);
    return this.adminOrders.detail(numberParam);
  }

  /** POST /api/admin/orders/:number/refunds/:id/retry (`orders.cancel`): same idempotency key. */
  async retryRefund(numberParam: string, refundId: string, actor: LifecycleActor): Promise<AdminOrderDetail> {
    const number = parseOrderNumber(numberParam);
    if (number === null || !UUID.test(refundId)) throw orderNotFound();
    const refund = await this.prisma.refund.findFirst({
      where: { id: refundId, order: { number } },
      select: { id: true },
    });
    if (!refund) throw orderNotFound();
    await this.refunds.retry(refund.id, actor);
    return this.adminOrders.detail(numberParam);
  }

  /** Adds the lines' quantities back to the stock of in-stock variants (the only ones that keep a count). */
  private async restock(
    tx: Prisma.TransactionClient,
    items: { variantId: number | null; quantity: number }[],
  ): Promise<void> {
    const quantities = new Map<number, number>();
    for (const item of items)
      if (item.variantId !== null)
        quantities.set(item.variantId, (quantities.get(item.variantId) ?? 0) + item.quantity);
    // After the order lock, by ascending id (locks.ts).
    await lockVariants(tx, [...quantities.keys()]);
    const variants = await tx.variant.findMany({
      where: { id: { in: [...quantities.keys()] }, fulfillment: FulfillmentMode.IN_STOCK },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const variant of variants)
      await tx.variant.update({
        where: { id: variant.id },
        data: { stock: { increment: quantities.get(variant.id)! } },
      });
  }

  /** Supersedes the order's live delivery slot, if any (its link then answers 404). */
  private async supersedeSlot(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    await tx.deliverySlot.updateMany({
      where: { orderId, state: { not: DeliverySlotState.SUPERSEDED } },
      data: { state: DeliverySlotState.SUPERSEDED },
    });
  }

  /** Supersedes the live slot, then inserts the new one (the partial unique index allows one live slot). */
  private async replaceSlot(tx: Prisma.TransactionClient, orderId: string, slot: DeliverySlotInput): Promise<void> {
    await this.supersedeSlot(tx, orderId);
    await tx.deliverySlot.create({
      data: {
        orderId,
        date: new Date(`${slot.date}T00:00:00.000Z`),
        windowFrom: slot.windowFrom,
        windowTo: slot.windowTo,
        note: slot.note ?? null,
      },
    });
  }

  /**
   * The outbox jobs of a status move (spec §5.3, decision 83), in the transaction of the move: an SMS for each new
   * delivery slot (also a slot-only change), an e-mail for `shipped` and `delivered`, and one for any cancel.
   */
  protected async onStatusChanged(
    tx: Prisma.TransactionClient,
    order: { id: string; number: number },
    from: OrderStatus,
    to: OrderStatus,
  ): Promise<void> {
    if (to === OrderStatus.DELIVERY_SCHEDULED) {
      // The slot inserted by this move (the only live one).
      const slot = await tx.deliverySlot.findFirstOrThrow({
        where: { orderId: order.id, state: { not: DeliverySlotState.SUPERSEDED } },
        select: { id: true },
      });
      await this.outbox.enqueue(tx, {
        type: 'sms.delivery_slot',
        dedupeKey: `sms.delivery_slot:${slot.id}`,
        payload: { orderId: order.id, slotId: slot.id },
        orderId: order.id,
      });
    } else if (from !== to && (to === OrderStatus.SHIPPED || to === OrderStatus.DELIVERED)) {
      const status = STATUS_VIEW[to];
      await this.outbox.enqueue(tx, {
        type: 'email.status',
        dedupeKey: `email.status:${order.id}:${status}`,
        payload: { orderId: order.id, status },
        orderId: order.id,
      });
    } else if (to === OrderStatus.CANCELLED) {
      await this.outbox.enqueue(tx, {
        type: 'email.cancelled',
        dedupeKey: `email.cancelled:${order.id}`,
        payload: { orderId: order.id },
        orderId: order.id,
      });
    }
  }
}

interface CancelInput {
  refund: CancelRefundChoice;
  amount?: number;
  reason: string;
  restock: boolean;
}

/** Validates the cancel body: 400 with the first bad `field` (`refund`, `reason`, `amount`, `restock`). */
function parseCancel(raw: unknown): CancelInput {
  const body = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<
    Record<keyof AdminCancelRequest, unknown>
  >;
  if (typeof body.refund !== 'string' || !(REFUND_CHOICES as readonly string[]).includes(body.refund))
    throw badField('refund');
  const refund = body.refund as CancelRefundChoice;
  const reason = parseReason(body.reason);
  if (reason === null) throw badField('reason');
  let amount: number | undefined;
  if (refund === 'partial') {
    const parsed = parseAmount(body.amount);
    if (parsed === null) throw badField('amount');
    amount = parsed;
  }
  if (body.restock !== undefined && typeof body.restock !== 'boolean') throw badField('restock');
  return { refund, amount, reason, restock: body.restock ?? true };
}
