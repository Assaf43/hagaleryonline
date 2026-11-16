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
import {
  DeliverySlotState,
  OrderChannel,
  OrderShippingMethod,
  OrderStatus,
  PaymentStatus,
  type Prisma,
} from '../generated/prisma/client.js';
import { invoiceViews, ORDER_INVOICES } from '../invoicing/invoice-view.js';
import { PAYABLE_ORDER, PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { promotionEnded } from '../promotions/discount-engine.js';
import { PromotionsService } from '../promotions/promotions.service.js';
import { DEFAULT_RETURN_WINDOW_DAYS, returnUntil } from '../support/support-input.js';
import { currentSlotView } from './delivery-slot.js';
import { lockCart, lockOrder, lockOrderPayments, lockStoreCart, lockVariants, lockWelcome } from './locks.js';
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

/**
 * Only failed or expired orders get a new payment page on the website; a paid one never, a pending one while its page
 * is open (the seller's retry may also reopen that one, `retryPayment`).
 */
export function retryable(order: { status: OrderStatus; reservedUntil: Date }, now = new Date()): boolean {
  const status = effectiveStatus(order, now);
  return status === OrderStatus.PAYMENT_FAILED || status === OrderStatus.EXPIRED;
}

/** The seller's retry (store orders): what the website retries, plus a pending order whose page is open (reopen). */
export function sellerRetryable(order: { status: OrderStatus; reservedUntil: Date }, now = new Date()): boolean {
  return retryable(order, now) || effectiveStatus(order, now) === OrderStatus.PENDING_PAYMENT;
}

/**
 * Who may read or cancel an order: the bearer of its URL token (`/order/:number?t=`), the signed-in account that
 * placed it (`/api/account/orders/:number`; only orders with that `customerId`, decision 77), or the seller of a store
 * order (`/api/admin/store-orders/:number`; only store orders with that `sellerId`, spec §8).
 */
export type OrderAccess = { token: string | undefined } | { customerId: string } | { sellerId: number };

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

  /**
   * GET /api/orders/:number?t= and GET /api/account/orders/:number — 404 for an unknown number, a wrong token or
   * another account's order.
   */
  async view(numberParam: string, access: OrderAccess): Promise<OrderView> {
    const order = await this.find(numberParam, access);
    const now = new Date();
    const status = effectiveStatus(order, now);
    const canRetryPayment =
      retryable(order, now) &&
      !(await this.superseded(this.prisma, order)) &&
      !(await this.promotionGone(this.prisma, order)) &&
      (await this.retryBlocker(this.prisma, order.items, await this.catalog.snapshot())) === null;
    const address = order.address as unknown as OrderAddressView;
    const deliveredAt = status === OrderStatus.DELIVERED ? order.deliveredAt : null;
    const returnWindowDays = deliveredAt
      ? ((await this.prisma.storeSettings.findUnique({ where: { id: 1 } }))?.returnWindowDays ??
        DEFAULT_RETURN_WINDOW_DAYS)
      : 0;
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
      deliveredAt: deliveredAt ? deliveredAt.toISOString() : null,
      returnUntil: deliveredAt ? returnUntil(deliveredAt, returnWindowDays).toISOString() : null,
      lines: order.items.map((i) => ({
        orderItemId: i.id,
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
   *
   * The seller's retry (`{ sellerId }`, POST /api/admin/store-orders/:number/retry) also reopens a store order still
   * waiting for its payment (a closed provider tab, a second "לתשלום"): its open payment rows are cancelled under
   * their locks (payments → order, as the cancel does), so the old page's result is a late result of a replaced
   * attempt — a failure is ignored, a success pays the order once and any further success is `paid_twice` (the
   * webhook's rules, unchanged). The provider returns to `/pay/done` for the seller, to the tokened page otherwise.
   */
  async retryPayment(numberParam: string, access: OrderAccess): Promise<CheckoutResponse> {
    const found = await this.find(numberParam, access);
    const bySeller = 'sellerId' in access;
    const snapshot = await this.catalog.snapshot();
    const order = await this.prisma.$transaction(
      async (tx) => {
        // Same order as checkout: store-cart → welcome → cart → (payments →) order → variants → promotion. A store
        // order's cart may be gone (store carts are deleted after 30 days, orders or not): the order alone is enough.
        if (found.channel === OrderChannel.STORE && found.sellerId !== null) await lockStoreCart(tx, found.sellerId);
        if (found.customerId) await lockWelcome(tx, found.customerId);
        if (found.cartId) await lockCart(tx, found.cartId);
        if (bySeller) await lockOrderPayments(tx, found.id);
        await lockOrder(tx, found.id);
        const current = await tx.order.findUniqueOrThrow({
          where: { id: found.id },
          include: { items: { select: { variantId: true, quantity: true } } },
        });
        const now = new Date();
        if (!(bySeller ? sellerRetryable(current, now) : retryable(current, now))) throw notRetryable();
        const reopen = effectiveStatus(current, now) === OrderStatus.PENDING_PAYMENT;
        if (await this.superseded(tx, current)) throw superseded();
        if (current.items.some((i) => i.variantId === null)) throw notRetryable();
        if (reopen) {
          // The old page is closed: its result no longer decides the order (the webhook ignores a failure of a
          // payment that is not the latest). Released for the stock check below: its own reservation must not count
          // against it — rolled back with everything else on a refusal.
          await tx.payment.updateMany({
            where: { orderId: current.id, status: PaymentStatus.PENDING },
            data: { status: PaymentStatus.CANCELLED },
          });
          await tx.order.update({ where: { id: current.id }, data: { status: OrderStatus.PAYMENT_FAILED } });
        }
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
          select: PAYABLE_ORDER,
        });
      },
      { timeout: 15_000 },
    );
    return { redirectUrl: await this.payments.openPaymentPage(order, bySeller ? 'store' : 'order') };
  }

  private async find(numberParam: string, access: OrderAccess) {
    const number = parseOrderNumber(numberParam);
    const token = 'token' in access ? access.token : null;
    if (number === null || token === undefined) throw orderNotFound();
    const order = await this.prisma.order.findUnique({
      where: { number },
      include: {
        items: { orderBy: { id: 'asc' } },
        slots: { where: { state: { not: DeliverySlotState.SUPERSEDED } } },
        ...ORDER_INVOICES,
      },
    });
    if (!order) throw orderNotFound();
    const allowed =
      token !== null
        ? tokenMatches(token, order.publicToken)
        : 'customerId' in access
          ? order.customerId === access.customerId
          : 'sellerId' in access && order.channel === OrderChannel.STORE && order.sellerId === access.sellerId;
    if (!allowed) throw orderNotFound();
    return order;
  }

  /**
   * The order's promotion can no longer be honored on a new payment page: inactive, out of its dates, or used up by
   * other orders (paid, or pending within their reservation — this order itself does not count). The welcome benefit
   * also ends once the account has a paid order or another live pending order holds it (decision 79).
   */
  private async promotionGone(
    db: Prisma.TransactionClient | PrismaService,
    order: { id: string; promotionId: number | null; customerId: string | null },
  ): Promise<boolean> {
    if (order.promotionId === null) return false;
    const rule = await this.promotions.byId(db, order.promotionId, { orderId: order.id });
    if (!rule || promotionEnded(rule, new Date())) return true;
    return (
      rule.isWelcome === true &&
      !(await this.promotions.welcomeStillOpen(db, { ...order, promotionId: order.promotionId }))
    );
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
