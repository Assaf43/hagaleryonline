import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderPage,
  AdminOrderPayment,
  AdminPaymentStatus,
  AdminRefund,
  OrderAddressView,
  OrderActorType as OrderActorView,
  OrderAttentionReason,
  OrderStatus as OrderStatusView,
  OrderView,
  ProvidersStatus,
  ShippingMethod,
  ShippingQuoteLine,
} from '@hg/models';
import {
  DeliverySlotState,
  OrderActorType,
  OrderShippingMethod,
  OrderStatus,
  PaymentStatus,
  RefundStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SHIPPING_PROVIDER, type ShippingProvider } from '../shipping/shipping-provider.js';
import { currentSlotView } from './delivery-slot.js';
import { orderNotFound } from './order-errors.js';
import { parseOrderNumber } from './order-number.js';
import { orderRefundState } from './refund-amount.js';
import { canCancel, nextStatuses } from './order-transitions.js';
import { effectiveStatus, publicDiscountInfo } from './orders.service.js';

export const ADMIN_ORDERS_PAGE_SIZE = 30;

const STATUS_VIEW: Record<OrderStatus, OrderStatusView> = {
  PENDING_PAYMENT: 'pending_payment',
  PAID: 'paid',
  PROCESSING: 'processing',
  DELIVERY_SCHEDULED: 'delivery_scheduled',
  SHIPPED: 'shipped',
  DELIVERED: 'delivered',
  CANCELLED: 'cancelled',
  PAYMENT_FAILED: 'payment_failed',
  EXPIRED: 'expired',
};
const METHOD_VIEW: Record<OrderShippingMethod, ShippingMethod> = {
  CURBSIDE: 'curbside',
  FULL_SERVICE: 'full_service',
};
const ACTOR_VIEW: Record<OrderActorType, OrderActorView> = {
  ADMIN: 'admin',
  CUSTOMER: 'customer',
  SYSTEM: 'system',
};
const PAYMENT_VIEW: Record<PaymentStatus, AdminPaymentStatus> = {
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** The `status` query values, as the models name them. */
export const ORDER_STATUS_FILTERS = ['pending_payment', 'paid', 'payment_failed', 'expired'] as const;
export type OrderStatusFilter = (typeof ORDER_STATUS_FILTERS)[number];

/**
 * The where clause of a status filter. A pending order past its reservation reads as expired (the same rule the
 * customer sees), so "pending" excludes it and "expired" includes it.
 */
export function statusWhere(status: OrderStatusFilter | undefined, now: Date): Prisma.OrderWhereInput {
  switch (status) {
    case undefined:
      return {};
    case 'pending_payment':
      return { status: OrderStatus.PENDING_PAYMENT, reservedUntil: { gt: now } };
    case 'expired':
      return {
        OR: [{ status: OrderStatus.EXPIRED }, { status: OrderStatus.PENDING_PAYMENT, reservedUntil: { lte: now } }],
      };
    case 'paid':
      return { status: OrderStatus.PAID };
    case 'payment_failed':
      return { status: OrderStatus.PAYMENT_FAILED };
  }
}

/** Payment `rawStatus` values the API itself writes when a payment needs a person. */
const ATTENTION_RAW: Record<string, OrderAttentionReason> = {
  paid_twice: 'paid_twice',
  amount_mismatch: 'amount_mismatch',
  superseded_paid: 'superseded_paid',
  late_payment: 'late_payment',
};
const REFUND_VIEW: Record<RefundStatus, AdminRefund['status']> = {
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
};

/** The reasons an order needs staff: a stock shortage, a flagged payment, or the order's own flag (a failed refund). */
export function attentionReasons(order: {
  stockShortage: boolean;
  needsAttention: boolean;
  payments: { rawStatus: string | null }[];
}): OrderAttentionReason[] {
  const reasons = new Set<OrderAttentionReason>();
  if (order.stockShortage) reasons.add('stock_shortage');
  if (order.needsAttention) reasons.add('flagged');
  for (const p of order.payments) {
    const reason = p.rawStatus ? ATTENTION_RAW[p.rawStatus] : undefined;
    if (reason) reasons.add(reason);
  }
  return [...reasons];
}

const ATTENTION_WHERE: Prisma.OrderWhereInput = {
  OR: [
    { stockShortage: true },
    { needsAttention: true },
    { payments: { some: { rawStatus: { in: Object.keys(ATTENTION_RAW) } } } },
  ],
};

/** Read-only orders for the admin (spec §5.5, ADM-13); status changes and refunds are Phase 5. */
@Injectable()
export class OrdersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
    @Inject(SHIPPING_PROVIDER) private readonly shipping: ShippingProvider,
  ) {}

  async list(status: OrderStatusFilter | undefined, page: number, attention = false): Promise<AdminOrderPage> {
    const now = new Date();
    const where: Prisma.OrderWhereInput = attention
      ? { AND: [statusWhere(status, now), ATTENTION_WHERE] }
      : statusWhere(status, now);
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (page - 1) * ADMIN_ORDERS_PAGE_SIZE,
        take: ADMIN_ORDERS_PAGE_SIZE,
        include: { items: { select: { quantity: true } }, payments: { select: { rawStatus: true } } },
      }),
    ]);
    return {
      items: rows.map((o) => {
        const contact = o.contact as { fullName: string; phone: string };
        const reasons = attentionReasons(o);
        return {
          number: o.number,
          createdAt: o.createdAt.toISOString(),
          customerName: contact.fullName,
          phone: contact.phone,
          total: o.total,
          status: STATUS_VIEW[effectiveStatus(o, now)],
          itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
          needsAttention: reasons.length > 0,
          attentionReasons: reasons,
        };
      }),
      total,
      page,
      pageSize: ADMIN_ORDERS_PAGE_SIZE,
    };
  }

  async detail(numberParam: string): Promise<AdminOrderDetail> {
    const number = parseOrderNumber(numberParam);
    if (number === null) throw orderNotFound();
    const order = await this.prisma.order.findUnique({
      where: { number },
      include: {
        items: { orderBy: { id: 'asc' } },
        payments: { orderBy: { createdAt: 'asc' } },
        slots: { where: { state: { not: DeliverySlotState.SUPERSEDED } } },
        events: { orderBy: { id: 'asc' } },
        refunds: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
      },
    });
    if (!order) throw orderNotFound();
    const payments: AdminOrderPayment[] = order.payments.map((p) => ({
      provider: p.provider,
      transactionId: p.transactionId,
      status: PAYMENT_VIEW[p.status],
      installments: p.installments,
      amount: p.amount,
      rawStatus: p.rawStatus,
      createdAt: p.createdAt.toISOString(),
    }));
    const reasons = attentionReasons(order);
    const refunds: AdminRefund[] = order.refunds.map((r) => ({
      id: r.id,
      amount: r.amount,
      reason: r.reason,
      status: REFUND_VIEW[r.status],
      provider: r.provider,
      adminUserId: r.adminUserId,
      error: r.error,
      createdAt: r.createdAt.toISOString(),
    }));
    return {
      number: order.number,
      status: STATUS_VIEW[effectiveStatus(order)],
      createdAt: order.createdAt.toISOString(),
      reservedUntil: order.reservedUntil.toISOString(),
      contact: order.contact as unknown as AdminOrderDetail['contact'],
      address: order.address as unknown as OrderAddressView,
      method: METHOD_VIEW[order.method],
      shippingTotal: order.shippingTotal,
      shippingLines: order.shippingLines as unknown as ShippingQuoteLine[],
      subtotal: order.subtotal,
      discount: order.discount,
      discountInfo: publicDiscountInfo(order.discountInfo),
      total: order.total,
      deliveryEstimate: (order.deliveryEstimate as OrderView['deliveryEstimate']) ?? null,
      lines: order.items.map((i) => ({
        variantId: i.variantId,
        sku: i.sku,
        modelName: i.modelName,
        nameHe: i.nameHe,
        optionLabels: i.optionLabels as string[],
        unitPrice: i.unitPrice,
        quantity: i.quantity,
        lineTotal: i.lineTotal,
      })),
      stockShortage: order.stockShortage,
      needsAttention: reasons.length > 0,
      attentionReasons: reasons,
      paymentProvider: order.paymentProvider,
      shippingProvider: order.shippingProvider,
      payments,
      refundedTotal: order.refundedTotal,
      refundable: orderRefundState(order).refundable,
      attentionNote: order.attentionNote,
      refunds,
      deliverySlot: currentSlotView(order.slots),
      canCancel: canCancel(effectiveStatus(order), 'admin'),
      nextStatuses: nextStatuses(order.status).map((s) => STATUS_VIEW[s]),
      statusEvents: order.events.map((e) => ({
        fromStatus: e.fromStatus ? STATUS_VIEW[e.fromStatus] : null,
        toStatus: STATUS_VIEW[e.toStatus],
        actorType: ACTOR_VIEW[e.actorType],
        actorAdminId: e.actorAdminId,
        note: e.note,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }

  providers(): ProvidersStatus {
    return {
      payment: { code: this.payment.code, testMode: this.payment.testMode },
      shipping: { code: this.shipping.code },
    };
  }
}
