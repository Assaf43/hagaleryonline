import { Injectable } from '@nestjs/common';
import {
  MAX_CUSTOMER_ADDRESSES,
  type CheckoutAddress,
  type CheckoutRequest,
  type StoreOrderCreated,
  type StoreOrderRetry,
  type StoreOrderStatus,
  type StorePendingAction,
  type StorePendingOrder,
} from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { CustomerOrigin, MarketingConsentSource, OrderStatus, type Prisma } from '../generated/prisma/client.js';
import { CheckoutService, parseOrderFields } from '../orders/checkout.service.js';
import { OrderLifecycleService } from '../orders/order-lifecycle.service.js';
import {
  customerEmailRequired,
  customerNotConfirmed,
  emptyCart,
  invalidInput,
  orderNotFound,
  orderPending,
} from '../orders/order-errors.js';
import { parseOrderNumber } from '../orders/order-number.js';
import { effectiveStatus, OrdersService, sellerRetryable, STATUS_VIEW } from '../orders/orders.service.js';
import { canCancel } from '../orders/order-transitions.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { hasPaidOrder } from '../promotions/promotions.service.js';
import { StoreCartService } from './store-cart.service.js';
import { isConfirmationLive } from './store-confirmation.js';
import { StoreService } from './store.service.js';

/** The seller's store-order request, validated: the checkout's fields without the contact (it is the account's). */
export type StoreOrderInput = Omit<CheckoutRequest, 'contact'> & { saveAddress: boolean };

/** Validates `POST /api/admin/store-orders` with the checkout's rules (400 with the first bad field). */
export function parseStoreOrderRequest(body: unknown): StoreOrderInput {
  const fields = parseOrderFields(body);
  const saveAddress = (body as Record<string, unknown> | null)?.saveAddress ?? true;
  if (typeof saveAddress !== 'boolean') throw invalidInput();
  return { ...fields, saveAddress };
}

export interface StoreActor {
  sellerId: number;
  ip?: string;
}

/**
 * The pending list: waiting for the payment, or failed (retry), while within the reservation — an order leaves it when
 * it is paid, cancelled or its 20 minutes are over (a retry starts them again).
 */
const LISTED = (now: Date): Prisma.OrderWhereInput => ({
  status: { in: [OrderStatus.PENDING_PAYMENT, OrderStatus.PAYMENT_FAILED] },
  reservedUntil: { gt: now },
});
const listed = (o: { status: OrderStatus; reservedUntil: Date }, now: Date) =>
  (o.status === OrderStatus.PENDING_PAYMENT || o.status === OrderStatus.PAYMENT_FAILED) && o.reservedUntil > now;

/**
 * What the seller may do with a listed order, by the rules the endpoints themselves apply: the seller's retry
 * (`sellerRetryable`: also reopens a waiting order) and the seller's cancel (`canCancel(…, 'seller')`).
 */
function pendingActions(o: { status: OrderStatus; reservedUntil: Date }, now: Date): StorePendingAction[] {
  const actions: StorePendingAction[] = [];
  if (sellerRetryable(o, now)) actions.push('retry');
  if (canCancel(effectiveStatus(o, now), 'seller')) actions.push('cancel');
  return actions;
}

const sameAddress = (a: CheckoutAddress, b: CheckoutAddress) =>
  a.localityId === b.localityId &&
  a.street === b.street &&
  a.houseNumber === b.houseNumber &&
  (a.apartment ?? null) === (b.apartment ?? null) &&
  a.floor === b.floor &&
  a.hasElevator === b.hasElevator &&
  (a.notes ?? null) === (b.notes ?? null);

/**
 * Seller-assisted store orders (spec §4.1 steps 3–5, §4.4, decisions 84 and 87): the seller's open store cart, with
 * its confirmed customer, becomes an order on the website's own checkout path (`CheckoutService.placeOrder`: the
 * same locks, stock, discount, shipping and `expectedTotal` checks), with `channel = store`, the seller and the
 * active store. The customer pays at once on the provider's page opened on the tablet, which returns to `/pay/done`.
 * A seller sees and acts only on their own store orders here.
 */
@Injectable()
export class StoreOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly checkout: CheckoutService,
    private readonly payments: PaymentsService,
    private readonly orders: OrdersService,
    private readonly lifecycle: OrderLifecycleService,
    private readonly storeCarts: StoreCartService,
    private readonly store: StoreService,
    private readonly audit: AuditService,
  ) {}

  /**
   * POST /api/admin/store-orders. Read first without locks (for the early, clear refusals), then re-checked inside
   * the order transaction under the seller's store-cart lock and the cart lock: the cart still has no order (a second submit of
   * the same sale → 409 `order_pending`, never a second order — `placeOrder` would otherwise expire the cart's own
   * pending order), and its customer is still the one read and still confirmed (else 409 `customer_not_confirmed`).
   * The order is for `storeCustomerId`: the welcome benefit is that account's, as in the store cart view.
   */
  async create(actor: StoreActor, body: unknown): Promise<StoreOrderCreated> {
    const input = parseStoreOrderRequest(body);
    const { sellerId } = actor;
    const { id: storeId } = await this.store.activeStore();
    const open = await this.storeCarts.open(sellerId);
    if (!open) {
      // The sale's cart already has its order (a second submit), or there is no sale at all.
      const pending = await this.newestListedOrder(sellerId);
      if (pending) throw orderPending(pending.number);
      throw emptyCart();
    }
    const cart = await this.prisma.cart.findUniqueOrThrow({
      where: { id: open.id },
      select: { createdAt: true, updatedAt: true, storeConfirmedAt: true, storeCustomer: true },
    });
    const customer = cart.storeCustomer;
    if (!customer || !isConfirmationLive(cart)) throw customerNotConfirmed();
    if (!customer.email) throw customerEmailRequired();
    const contact = { fullName: customer.fullName, phone: customer.phone, email: customer.email };

    const order = await this.checkout.placeOrder(
      { token: undefined, customerId: null, store: { sellerId, cartId: open.id } },
      { ...input, contact },
      {
        customerId: customer.id,
        channel: 'store',
        sellerId,
        storeId,
        verify: async (tx, cartId) => {
          const now = await tx.cart.findUnique({
            where: { id: cartId },
            select: {
              sellerId: true,
              storeCustomerId: true,
              storeConfirmedAt: true,
              updatedAt: true,
              orders: { select: { number: true, status: true, reservedUntil: true }, orderBy: { number: 'desc' } },
            },
          });
          if (!now || now.sellerId !== sellerId) throw emptyCart();
          const at = new Date();
          const live = now.orders.find((o) => listed(o, at));
          if (live) throw orderPending(live.number);
          // One order per sale: a cart whose order was paid, cancelled or expired is no longer the open one.
          if (now.orders.length > 0) throw emptyCart();
          if (now.storeCustomerId !== customer.id || !isConfirmationLive(now, at)) throw customerNotConfirmed();
          const still = await tx.customer.findUnique({ where: { id: customer.id }, select: { email: true } });
          if (!still?.email) throw customerEmailRequired();
        },
        afterCreate: async (tx, created) => {
          if (input.saveAddress) await saveAddress(tx, customer.id, input.address);
          // A quick account gives its marketing consent at its first store order (source `store`), whichever cart or
          // seller that is: an account made at the store, with no paid order, whose consent was never recorded (a
          // withdrawn one keeps its time). Any other account's consent is its own (the order keeps the checkbox).
          if (
            input.marketingConsent &&
            customer.createdVia === CustomerOrigin.STORE &&
            !(await hasPaidOrder(tx, customer.id))
          )
            await tx.customer.updateMany({
              where: { id: customer.id, marketingConsent: false, marketingConsentAt: null },
              data: {
                marketingConsent: true,
                marketingConsentAt: new Date(),
                marketingConsentSource: MarketingConsentSource.STORE,
                marketingWithdrawnAt: null,
              },
            });
          await this.audit.record(
            {
              actorId: sellerId,
              action: 'store_order.create',
              entityType: 'order',
              entityId: created.number,
              after: { number: created.number, customerId: customer.id },
              ip: actor.ip,
            },
            tx,
          );
        },
      },
    );
    return { number: order.number, redirectUrl: await this.payments.openPaymentPage(order, 'store') };
  }

  /** GET /api/admin/store-orders/pending — this seller's store orders not paid yet, newest first. */
  async pending(sellerId: number): Promise<StorePendingOrder[]> {
    const now = new Date();
    const rows = await this.prisma.order.findMany({
      where: { sellerId, ...LISTED(now) },
      orderBy: { number: 'desc' },
      select: { number: true, contact: true, total: true, status: true, reservedUntil: true },
      take: 50,
    });
    return rows.map((o) => ({
      number: o.number,
      fullName: (o.contact as { fullName?: string }).fullName ?? '',
      total: o.total,
      status: o.status === OrderStatus.PAYMENT_FAILED ? 'payment_failed' : 'pending_payment',
      reservedUntil: o.reservedUntil.toISOString(),
      actions: pendingActions(o, now),
    }));
  }

  /** GET /api/admin/store-orders/:number — the seller's own store order; 404 for any other order. */
  async status(sellerId: number, numberParam: string): Promise<StoreOrderStatus> {
    const order = await this.own(sellerId, numberParam);
    return { number: order.number, status: STATUS_VIEW[effectiveStatus(order)], total: order.total };
  }

  /**
   * POST /api/admin/store-orders/:number/retry — the website's retry rules for the seller's own store order, plus the
   * reopen of an order still waiting for its payment (`OrdersService.retryPayment`); returns to `/pay/done`.
   */
  retry(sellerId: number, numberParam: string): Promise<StoreOrderRetry> {
    return this.orders.retryPayment(numberParam, { sellerId });
  }

  /** POST /api/admin/store-orders/:number/cancel — an unpaid (waiting or failed) store order of this seller (audited). */
  async cancel(actor: StoreActor, numberParam: string): Promise<StoreOrderStatus> {
    const view = await this.lifecycle.cancelStoreOrder(numberParam, { adminId: actor.sellerId, ip: actor.ip });
    return { number: view.number, status: view.status, total: view.total };
  }

  private async own(sellerId: number, numberParam: string) {
    const number = parseOrderNumber(numberParam);
    if (number === null) throw orderNotFound();
    const order = await this.prisma.order.findFirst({
      where: { number, sellerId },
      select: { number: true, status: true, total: true, reservedUntil: true },
    });
    if (!order) throw orderNotFound();
    return order;
  }

  /** The newest listed order (waiting or failed) of the seller's newest store cart, if any. */
  private async newestListedOrder(sellerId: number): Promise<{ number: number } | null> {
    const cart = await this.prisma.cart.findFirst({
      where: { sellerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      select: { orders: { where: LISTED(new Date()), orderBy: { number: 'desc' }, take: 1, select: { number: true } } },
    });
    return cart?.orders[0] ?? null;
  }
}

/**
 * Adds the delivery address to the account (spec §4.1 step 3) unless it is already there with the same fields; the
 * first address becomes the default. Under the customer row lock, as the account's own address writes. An account at
 * its address limit keeps its addresses (the order has its own copy).
 */
async function saveAddress(tx: Prisma.TransactionClient, customerId: string, address: CheckoutAddress): Promise<void> {
  await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId}::uuid FOR NO KEY UPDATE`;
  const saved = await tx.customerAddress.findMany({ where: { customerId } });
  if (saved.some((a) => sameAddress(a, address))) return;
  if (saved.length >= MAX_CUSTOMER_ADDRESSES) return;
  const { localityId, street, houseNumber, apartment, floor, hasElevator, notes } = address;
  await tx.customerAddress.create({
    data: {
      customerId,
      localityId,
      street,
      houseNumber,
      apartment,
      floor,
      hasElevator,
      notes,
      isDefault: saved.length === 0,
    },
  });
}
