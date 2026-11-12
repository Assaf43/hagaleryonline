import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  ORDER_STATUS_LABELS_HE,
  type CheckoutResponse,
  type OrderAddressView,
  type OrderStatus as OrderStatusView,
  type OrderView,
  type ShippingMethod,
  type ShippingQuoteLine,
} from '@hg/models';
import { availableStock } from '../cart/available-stock.js';
import { availability } from '../cart/cart-lines.js';
import type { CatalogSnapshot } from '../catalog/catalog-snapshot.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { DeliverySlotState, OrderShippingMethod, OrderStatus, type Prisma } from '../generated/prisma/client.js';
import { invoiceViews, ORDER_INVOICES } from '../invoicing/invoice-view.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { promotionEnded } from '../promotions/discount-engine.js';
import { PromotionsService } from '../promotions/promotions.service.js';
import { currentSlotView } from './delivery-slot.js';
import { lockCart, lockOrder, lockVariants } from './locks.js';
import { notRetryable, orderNotFound, promotionEndedError, shortage, superseded } from './order-errors.js';
import { parseOrderNumber, reservedUntil } from './order-number.js';
import { canCancel } from './order-transitions.js';

export const STATUS_VIEW: Record<OrderStatus, OrderStatusView> = {
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

type OrderItemRow = { variantId: number | null; quantity: number };

/** The status a customer sees: a pending order past its reservation reads as expired (spec §5.2). */
export function effectiveStatus(order: { status: OrderStatus; reservedUntil: Date }, now = new Date()): OrderStatus {
  return order.status === OrderStatus.PENDING_PAYMENT && order.reservedUntil <= now
    ? OrderStatus.EXPIRED
    : order.status;
}

/** Only failed or expired orders get a new payment page; a paid one never, a pending one while its page is open. */
function retryable(order: { status: OrderStatus; reservedUntil: Date }, now = new Date()): boolean {
  const status = effectiveStatus(order, now);
  return status === OrderStatus.PAYMENT_FAILED || status === OrderStatus.EXPIRED;
}

/** Constant-time comparison of the URL token with the order's (both hashed to equal length first). */
export function tokenMatches(given: string, expected: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return given.length > 0 && timingSafeEqual(digest(given), digest(expected));
}

/** The confirmation page (spec §5.5) and "נסו לשלם שוב" (spec §5.4). The URL token is the only key. */
@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly payments: PaymentsService,
    private readonly promotions: PromotionsService,
  ) {}

  /** GET /api/orders/:number?t= — 404 for an unknown number or a wrong token. */
  async view(numberParam: string, token: string | undefined): Promise<OrderView> {
    const order = await this.find(numberParam, token);
    const now = new Date();
    const status = effectiveStatus(order, now);
    const canRetryPayment =
      retryable(order, now) &&
      !(await this.superseded(this.prisma, order)) &&
      !(await this.promotionGone(this.prisma, order)) &&
      (await this.retryBlocker(this.prisma, order.items, await this.catalog.snapshot())) === null;
    const address = order.address as unknown as OrderAddressView;
    return {
      invoices: invoiceViews(order.invoices),
      number: order.number,
      status: STATUS_VIEW[status],
      statusLabelHe: ORDER_STATUS_LABELS_HE[STATUS_VIEW[status]],
      canCancel: canCancel(status, 'customer'),
      refundedTotal: order.refundedTotal,
      deliverySlot: currentSlotView(order.slots),
      createdAt: order.createdAt.toISOString(),
      reservedUntil: order.reservedUntil.toISOString(),
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
      address: {
        localityId: address.localityId,
        localityNameHe: address.localityNameHe,
        street: address.street,
        houseNumber: address.houseNumber,
        apartment: address.apartment,
        floor: address.floor,
        hasElevator: address.hasElevator,
        notes: address.notes,
      },
      method: METHOD_VIEW[order.method],
      shippingTotal: order.shippingTotal,
      shippingLines: order.shippingLines as unknown as ShippingQuoteLine[],
      subtotal: order.subtotal,
      discount: order.discount,
      discountInfo: publicDiscountInfo(order.discountInfo),
      total: order.total,
      deliveryEstimate: (order.deliveryEstimate as OrderView['deliveryEstimate']) ?? null,
      canRetryPayment,
      stockShortage: order.stockShortage,
    };
  }

  /**
   * POST /api/orders/:number/retry-payment?t= — a new payment page for a failed or expired order whose lines can
   * all still be bought, at the order's own prices. Under the order and variant locks it re-reserves the stock for
   * 20 minutes; the provider call happens after commit. 409 `not_retryable` or `insufficient_stock` otherwise, and
   * `promotion_ended` when the order's promotion or coupon is no longer active, out of its dates or used up by other
   * orders — the order's discounted total would no longer be honored (spec §6).
   */
  async retryPayment(numberParam: string, token: string | undefined): Promise<CheckoutResponse> {
    const found = await this.find(numberParam, token);
    const snapshot = await this.catalog.snapshot();
    const order = await this.prisma.$transaction(
      async (tx) => {
        // Same order as checkout: cart → order → variants → promotion.
        if (found.cartId) await lockCart(tx, found.cartId);
        await lockOrder(tx, found.id);
        const current = await tx.order.findUniqueOrThrow({
          where: { id: found.id },
          include: { items: { select: { variantId: true, quantity: true } } },
        });
        if (!retryable(current)) throw notRetryable();
        if (await this.superseded(tx, current)) throw superseded();
        if (current.items.some((i) => i.variantId === null)) throw notRetryable();
        await lockVariants(
          tx,
          current.items.map((i) => i.variantId!),
        );
        const blocker = await this.retryBlocker(tx, current.items, snapshot);
        if (blocker) throw shortage(blocker.variantId, blocker.available);
        if (current.promotionId !== null) await this.promotions.lockOne(tx, current.promotionId);
        if (await this.promotionGone(tx, current)) throw promotionEndedError();
        return tx.order.update({
          where: { id: current.id },
          data: { status: OrderStatus.PENDING_PAYMENT, reservedUntil: reservedUntil() },
          select: { id: true, number: true, total: true, contact: true },
        });
      },
      { timeout: 15_000 },
    );
    return { redirectUrl: await this.payments.openPaymentPage(order) };
  }

  private async find(numberParam: string, token: string | undefined) {
    const number = parseOrderNumber(numberParam);
    if (number === null || typeof token !== 'string') throw orderNotFound();
    const order = await this.prisma.order.findUnique({
      where: { number },
      include: {
        items: { orderBy: { id: 'asc' } },
        slots: { where: { state: { not: DeliverySlotState.SUPERSEDED } } },
        ...ORDER_INVOICES,
      },
    });
    if (!order || !tokenMatches(token, order.publicToken)) throw orderNotFound();
    return order;
  }

  /**
   * The order's promotion can no longer be honored on a new payment page: inactive, out of its dates, or used up by
   * other orders (paid, or pending within their reservation — this order itself does not count).
   */
  private async promotionGone(
    db: Prisma.TransactionClient | PrismaService,
    order: { id: string; promotionId: number | null },
  ): Promise<boolean> {
    if (order.promotionId === null) return false;
    const rule = await this.promotions.byId(db, order.promotionId, { orderId: order.id });
    return !rule || promotionEnded(rule, new Date());
  }

  /** A newer order was placed from the same cart (it replaced this one): pay that one, not this. */
  private async superseded(
    db: Prisma.TransactionClient | PrismaService,
    order: { cartId: string | null; number: number },
  ): Promise<boolean> {
    if (!order.cartId) return false;
    return (await db.order.count({ where: { cartId: order.cartId, number: { gt: order.number } } })) > 0;
  }

  /** The first line that cannot be bought again in its quantity (its variant shown and enough available), or null. */
  private async retryBlocker(
    db: Prisma.TransactionClient | PrismaService,
    items: OrderItemRow[],
    snapshot: CatalogSnapshot,
  ): Promise<{ variantId: number; available: number } | null> {
    const ids = items.flatMap((i) => (i.variantId === null ? [] : [i.variantId]));
    if (ids.length < items.length) return { variantId: 0, available: 0 };
    const stock = await availableStock(db, ids);
    const variants = await db.variant.findMany({
      where: { id: { in: ids } },
      select: { id: true, active: true, fulfillment: true },
    });
    for (const item of items) {
      const variant = variants.find((v) => v.id === item.variantId);
      const limit = variant ? availability(snapshot, variant.id, variant, stock).limit : 0;
      if (item.quantity > limit) return { variantId: item.variantId!, available: limit };
    }
    return null;
  }
}

/** The public part of the order's discount snapshot (`orders.discount_info`): only the typed fields. */
export function publicDiscountInfo(raw: Prisma.JsonValue | null): OrderView['discountInfo'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const { labelHe, source, code } = raw as Record<string, unknown>;
  if (typeof labelHe !== 'string' || (source !== 'automatic' && source !== 'coupon')) return null;
  return { labelHe, source, code: typeof code === 'string' ? code : null };
}
