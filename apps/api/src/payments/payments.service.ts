import type { IncomingHttpHeaders } from 'node:http';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import type { SandboxCompleteRequest, SandboxCompleteResponse, SandboxPaymentView } from '@hg/models';
import { FulfillmentMode, OrderStatus, PaymentStatus, type Prisma } from '../generated/prisma/client.js';
import { lockOrder, lockVariants } from '../orders/locks.js';
import { CheckoutError, invalidInput, orderNotFound, paymentUnavailable } from '../orders/order-errors.js';
import { confirmationPath } from '../orders/order-number.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  PAYMENT_PROVIDER,
  WebhookPayloadError,
  WebhookSignatureError,
  type PaymentOutcome,
  type PaymentProvider,
  type PaymentResult,
} from './payment-provider.js';
import { SandboxPaymentProvider } from './sandbox-payment.provider.js';
import { WebhookDispatcher } from './webhook-dispatcher.js';

const PAYMENT_STATUS: Record<PaymentOutcome, PaymentStatus> = {
  succeeded: PaymentStatus.SUCCEEDED,
  failed: PaymentStatus.FAILED,
  cancelled: PaymentStatus.CANCELLED,
};
const SANDBOX_OUTCOME: Record<SandboxCompleteRequest['outcome'], PaymentOutcome> = {
  success: 'succeeded',
  failure: 'failed',
  cancel: 'cancelled',
};
const VIEW_STATUS: Record<PaymentStatus, SandboxPaymentView['status']> = {
  PENDING: 'pending',
  SUCCEEDED: 'succeeded',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

/** What happened to a webhook: applied, or recognized as a repeat / out-of-order call and ignored. */
export type WebhookOutcome = 'paid' | 'failed' | 'amount_mismatch' | 'duplicate' | 'ignored';

/** The order fields needed to open a payment page. */
export interface PayableOrder {
  id: string;
  number: number;
  total: number;
  contact: Prisma.JsonValue;
}

/**
 * Payments (spec §5.3, §5.4): opening the provider's payment page for an order, and applying the provider's
 * webhook to the payment and its order in one transaction. Never stores card data (NFR-10).
 */
@Injectable()
export class PaymentsService {
  private readonly logger = new Logger(PaymentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
    private readonly dispatcher: WebhookDispatcher,
  ) {}

  get providerCode(): string {
    return this.provider.code;
  }

  /**
   * Asks the provider for a payment page and records the pending payment. Called after the order's transaction
   * committed, so no row lock is held during the provider call. If the provider fails, the order is marked
   * failed at once (its reservation is released) and the customer can retry.
   */
  async openPaymentPage(order: PayableOrder): Promise<string> {
    let page: { redirectUrl: string; transactionId: string };
    try {
      const contact = order.contact as { fullName: string; phone: string; email: string };
      page = await this.provider.createPaymentPage({
        orderId: order.id,
        orderNumber: order.number,
        amount: order.total,
        customer: { fullName: contact.fullName, phone: contact.phone, email: contact.email },
      });
    } catch (error) {
      this.logger.error(`Payment page for order ${order.number} failed`, error);
      await this.failPending(order.id);
      throw paymentUnavailable();
    }
    try {
      await this.prisma.payment.create({
        data: {
          orderId: order.id,
          provider: this.provider.code,
          transactionId: page.transactionId,
          amount: order.total,
        },
      });
    } catch (error) {
      // Without the payment row its webhook could not be matched: never send the customer to that page.
      this.logger.error(`Recording payment ${page.transactionId} of order ${order.number} failed`, error);
      await this.failPending(order.id);
      throw paymentUnavailable();
    }
    return page.redirectUrl;
  }

  /** Marks a pending order failed, which releases its reservation (best effort: the caller reports the failure). */
  private async failPending(orderId: string): Promise<void> {
    await this.prisma.order
      .updateMany({
        where: { id: orderId, status: OrderStatus.PENDING_PAYMENT },
        data: { status: OrderStatus.PAYMENT_FAILED },
      })
      .catch((error: unknown) => this.logger.error(`Could not release order ${orderId}`, error));
  }

  /** POST /api/payments/webhook: verify the signature over the raw body, then apply (401 / 400 otherwise). */
  async handleWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<WebhookOutcome> {
    let result: PaymentResult;
    try {
      result = await this.provider.verifyWebhook(headers, rawBody);
    } catch (e) {
      if (e instanceof WebhookSignatureError) throw new CheckoutError(HttpStatus.UNAUTHORIZED, 'invalid_signature');
      if (e instanceof WebhookPayloadError) throw new CheckoutError(HttpStatus.BAD_REQUEST, 'invalid_payload');
      throw e;
    }
    return this.apply(result);
  }

  /**
   * Applies a verified result (spec §5.4) in one transaction, with the payment and then its order locked, so
   * repeated or concurrent deliveries are applied once:
   * - the same status again → no-op;
   * - a paid order never changes (a later failure is ignored);
   * - success with an amount other than the one asked → payment flagged `amount_mismatch`, order stays as it is;
   * - success → payment succeeded, order paid, in-stock stock taken (never below 0; a shortfall flags the order
   *   `stockShortage`), the order's lines removed from its cart unless a newer order of that cart exists;
   * - failure / cancel → payment failed / cancelled; the order fails (releasing its reservation) only when this is
   *   its latest payment, so a late failure of an earlier attempt does not disturb a retry in progress.
   */
  async apply(result: PaymentResult): Promise<WebhookOutcome> {
    const outcome = await this.prisma.$transaction(async (tx): Promise<WebhookOutcome> => {
      const [locked] = await tx.$queryRaw<{ id: string; order_id: string }[]>`
        SELECT id, order_id FROM payments WHERE transaction_id = ${result.transactionId} FOR UPDATE`;
      if (!locked) throw orderNotFound();
      await lockOrder(tx, locked.order_id);
      const payment = await tx.payment.findUniqueOrThrow({ where: { id: locked.id } });
      if (payment.provider !== this.provider.code) throw orderNotFound();
      const order = await tx.order.findUniqueOrThrow({
        where: { id: payment.orderId },
        include: { items: { select: { variantId: true, quantity: true } } },
      });
      const next = PAYMENT_STATUS[result.status];
      const installments = result.installments ?? payment.installments;

      if (payment.status === next) return 'duplicate';

      if (order.status === OrderStatus.PAID) {
        if (next === PaymentStatus.SUCCEEDED) {
          // Another attempt of an order that is already paid also went through: keep it for staff to refund.
          await tx.payment.update({
            where: { id: payment.id },
            data: { status: next, installments, rawStatus: 'paid_twice' },
          });
          this.logger.warn(`Order ${order.number} was paid twice (transaction ${payment.transactionId})`);
        }
        return 'ignored';
      }
      if (payment.status === PaymentStatus.SUCCEEDED) return 'ignored';

      if (next === PaymentStatus.SUCCEEDED) {
        if (result.amount !== payment.amount || payment.amount !== order.total) {
          await tx.payment.update({
            where: { id: payment.id },
            data: { installments, rawStatus: 'amount_mismatch' },
          });
          this.logger.warn(
            `Order ${order.number}: paid ${result.amount} instead of ${payment.amount} (transaction ${payment.transactionId})`,
          );
          return 'amount_mismatch';
        }
        await tx.payment.update({
          where: { id: payment.id },
          data: { status: next, installments, rawStatus: result.rawStatus },
        });
        const ordered = order.items.flatMap((i) => (i.variantId === null ? [] : [{ ...i, variantId: i.variantId }]));
        // The cart is cleared only when this is its latest order: a newer pending order of the same cart (placed
        // after this one was superseded) still needs those lines.
        if (order.cartId) {
          const newer = await tx.order.count({ where: { cartId: order.cartId, number: { gt: order.number } } });
          if (newer === 0)
            await tx.cartItem.deleteMany({
              where: { cartId: order.cartId, variantId: { in: ordered.map((i) => i.variantId) } },
            });
        }
        const stockShortage = await this.takeStock(tx, ordered);
        if (stockShortage)
          this.logger.warn(`Order ${order.number} was paid but an in-stock line no longer had enough stock`);
        await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAID, stockShortage } });
        await this.onPaid(tx, order.id);
        return 'paid';
      }

      await tx.payment.update({
        where: { id: payment.id },
        data: { status: next, installments, rawStatus: result.rawStatus },
      });
      const latest = await tx.payment.findFirst({
        where: { orderId: order.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (latest?.id !== payment.id) return 'ignored';
      await tx.order.update({ where: { id: order.id }, data: { status: OrderStatus.PAYMENT_FAILED } });
      return 'failed';
    });
    return outcome;
  }

  /**
   * Takes the paid quantities from stock, under the variant locks (after the payment and order locks). Only in-stock
   * variants keep a stock count — made-to-order and pre-order are not limited by it (the cart limit rule) — and
   * stock never goes below 0. True when an in-stock variant had less than the order needs (a late payment after
   * the reservation expired and the units were sold): the order is flagged for staff.
   */
  private async takeStock(
    tx: Prisma.TransactionClient,
    items: { variantId: number; quantity: number }[],
  ): Promise<boolean> {
    // All the order's variants are locked (a superset of the in-stock ones), so the fulfillment read below is the
    // one in force until commit.
    await lockVariants(
      tx,
      items.map((i) => i.variantId),
    );
    const variants = await tx.variant.findMany({
      where: { id: { in: items.map((i) => i.variantId) }, fulfillment: FulfillmentMode.IN_STOCK },
      select: { id: true, stock: true },
      orderBy: { id: 'asc' },
    });
    let shortage = false;
    for (const variant of variants) {
      const quantity = items.find((i) => i.variantId === variant.id)!.quantity;
      if (variant.stock < quantity) shortage = true;
      await tx.variant.update({ where: { id: variant.id }, data: { stock: Math.max(0, variant.stock - quantity) } });
    }
    return shortage;
  }

  /** Runs inside the webhook transaction when an order becomes paid. Coupon usage +1 comes here in Phase 4d. */
  private async onPaid(tx: Prisma.TransactionClient, orderId: string): Promise<void> {
    void tx;
    void orderId;
    await Promise.resolve();
  }

  // ---------- Sandbox (development only, CHK-10) ----------

  /** GET /api/payments/sandbox/:transactionId — what the sandbox page shows. */
  async sandboxView(transactionId: string): Promise<SandboxPaymentView> {
    const payment = await this.sandboxPayment(transactionId);
    return {
      transactionId: payment.transactionId,
      orderNumber: payment.order.number,
      amount: payment.amount,
      status: VIEW_STATUS[payment.status],
    };
  }

  /**
   * POST /api/payments/sandbox/:transactionId/complete: builds the webhook the provider would send, signs it and
   * delivers it to our own webhook endpoint over HTTP, then returns the confirmation page.
   */
  async completeSandbox(transactionId: string, body: unknown): Promise<SandboxCompleteResponse> {
    const sandbox = this.sandbox();
    const { outcome, installments } = parseComplete(body);
    const payment = await this.sandboxPayment(transactionId);
    const webhook = sandbox.signedWebhook({
      transactionId: payment.transactionId,
      status: SANDBOX_OUTCOME[outcome],
      amount: payment.amount,
      installments,
    });
    let status: number;
    try {
      status = await this.dispatcher.deliver(webhook.body, webhook.headers);
    } catch (error) {
      this.logger.error('Sandbox webhook delivery failed', error);
      throw paymentUnavailable();
    }
    if (status < 200 || status >= 300) {
      this.logger.error(`Sandbox webhook answered ${status}`);
      throw paymentUnavailable();
    }
    return { confirmationUrl: confirmationPath(payment.order.number, payment.order.publicToken) };
  }

  /** 404 unless the active provider is the sandbox. */
  private sandbox(): SandboxPaymentProvider {
    if (!(this.provider instanceof SandboxPaymentProvider)) throw orderNotFound();
    return this.provider;
  }

  private async sandboxPayment(transactionId: string) {
    const sandbox = this.sandbox();
    const payment = await this.prisma.payment.findUnique({
      where: { transactionId },
      include: { order: { select: { number: true, publicToken: true } } },
    });
    if (!payment || payment.provider !== sandbox.code) throw orderNotFound();
    return payment;
  }
}

function parseComplete(body: unknown): SandboxCompleteRequest {
  const { outcome, installments } = (body ?? {}) as Record<string, unknown>;
  if (typeof outcome !== 'string' || !Object.hasOwn(SANDBOX_OUTCOME, outcome)) throw invalidInput();
  if (typeof installments !== 'number' || !Number.isInteger(installments) || installments < 1 || installments > 12)
    throw invalidInput();
  return { outcome: outcome as SandboxCompleteRequest['outcome'], installments };
}
