import { Inject, Injectable } from '@nestjs/common';
import type {
  AdminOrderDetail,
  AdminOrderPage,
  AdminOrderPayment,
  AdminPaymentStatus,
  OrderAddressView,
  OrderStatus as OrderStatusView,
  OrderView,
  ProvidersStatus,
  ShippingMethod,
  ShippingQuoteLine,
} from '@hg/models';
import { OrderShippingMethod, OrderStatus, PaymentStatus, type Prisma } from '../generated/prisma/client.js';
import { PAYMENT_PROVIDER, type PaymentProvider } from '../payments/payment-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { SHIPPING_PROVIDER, type ShippingProvider } from '../shipping/shipping-provider.js';
import { orderNotFound } from './order-errors.js';
import { parseOrderNumber } from './order-number.js';
import { effectiveStatus } from './orders.service.js';

export const ADMIN_ORDERS_PAGE_SIZE = 30;

const STATUS_VIEW: Record<OrderStatus, OrderStatusView> = {
  PENDING_PAYMENT: 'pending_payment',
  PAID: 'paid',
  PAYMENT_FAILED: 'payment_failed',
  EXPIRED: 'expired',
};
const METHOD_VIEW: Record<OrderShippingMethod, ShippingMethod> = {
  CURBSIDE: 'curbside',
  FULL_SERVICE: 'full_service',
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

/** Read-only orders for the admin (spec §5.5, ADM-13); status changes and refunds are Phase 5. */
@Injectable()
export class OrdersAdminService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly payment: PaymentProvider,
    @Inject(SHIPPING_PROVIDER) private readonly shipping: ShippingProvider,
  ) {}

  async list(status: OrderStatusFilter | undefined, page: number): Promise<AdminOrderPage> {
    const now = new Date();
    const where = statusWhere(status, now);
    const [total, rows] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { number: 'desc' }],
        skip: (page - 1) * ADMIN_ORDERS_PAGE_SIZE,
        take: ADMIN_ORDERS_PAGE_SIZE,
        include: { items: { select: { quantity: true } } },
      }),
    ]);
    return {
      items: rows.map((o) => {
        const contact = o.contact as { fullName: string; phone: string };
        return {
          number: o.number,
          createdAt: o.createdAt.toISOString(),
          customerName: contact.fullName,
          phone: contact.phone,
          total: o.total,
          status: STATUS_VIEW[effectiveStatus(o, now)],
          itemCount: o.items.reduce((sum, i) => sum + i.quantity, 0),
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
      include: { items: { orderBy: { id: 'asc' } }, payments: { orderBy: { createdAt: 'asc' } } },
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
      discountInfo: (order.discountInfo as OrderView['discountInfo']) ?? null,
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
      paymentProvider: order.paymentProvider,
      shippingProvider: order.shippingProvider,
      payments,
    };
  }

  providers(): ProvidersStatus {
    return {
      payment: { code: this.payment.code, testMode: this.payment.testMode },
      shipping: { code: this.shipping.code },
    };
  }
}
