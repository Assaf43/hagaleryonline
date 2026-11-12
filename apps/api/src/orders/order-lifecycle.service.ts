import { HttpStatus, Injectable } from '@nestjs/common';
import type { AdminOrderDetail, DeliverySlotInput, OrderStatus as OrderStatusView, OrderView } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import {
  DeliverySlotState,
  OrderActorType,
  OrderStatus,
  PaymentStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { parseSlot } from './delivery-slot.js';
import { lockOrder, lockOrderPayments } from './locks.js';
import { CheckoutError, invalidInput, orderNotFound } from './order-errors.js';
import { parseOrderNumber } from './order-number.js';
import { canAdvance, canCancel } from './order-transitions.js';
import { OrdersAdminService } from './orders-admin.service.js';
import { effectiveStatus, OrdersService, STATUS_VIEW } from './orders.service.js';

const STATUS_FROM_VIEW = new Map<string, OrderStatus>(
  (Object.entries(STATUS_VIEW) as [OrderStatus, OrderStatusView][]).map(([prisma, view]) => [view, prisma]),
);

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
   * POST /api/orders/:number/cancel?t= — only while waiting for payment (and within the reservation). Locks the
   * order's payments, then the order (the webhook's lock order), so a payment webhook landing at the same moment
   * either wins (the order is paid: 409) or finds the payment cancelled.
   */
  async cancelByCustomer(numberParam: string, token: string | undefined): Promise<OrderView> {
    // The 404 for an unknown number or a wrong token is the view's.
    await this.orders.view(numberParam, token);
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
    return this.orders.view(numberParam, token);
  }

  /** Supersedes the live slot, then inserts the new one (the partial unique index allows one live slot). */
  private async replaceSlot(tx: Prisma.TransactionClient, orderId: string, slot: DeliverySlotInput): Promise<void> {
    await tx.deliverySlot.updateMany({
      where: { orderId, state: { not: DeliverySlotState.SUPERSEDED } },
      data: { state: DeliverySlotState.SUPERSEDED },
    });
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

  /** Hook for the outbox jobs of later tasks (notifications, invoices); called in the transaction of every change. */
  protected onStatusChanged(
    _tx: Prisma.TransactionClient,
    _order: { id: string; number: number },
    _from: OrderStatus,
    _to: OrderStatus,
  ): Promise<void> {
    return Promise.resolve();
  }
}
