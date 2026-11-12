import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../audit/audit.service.js';
import { PaymentStatus, Prisma, RefundStatus, type Refund } from '../generated/prisma/client.js';
import { PAYMENT_PROVIDER, type PaymentProvider, type RefundResult } from '../payments/payment-provider.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { lockOrder } from './locks.js';
import { CheckoutError, orderNotFound } from './order-errors.js';
import { orderRefundState } from './refund-amount.js';

/** The order's "needs attention" note after a refund the provider did not make. */
export const REFUND_FAILED_NOTE = 'ההחזר הכספי נכשל — יש לנסות שוב';

/** A PENDING refund untouched this long is taken to have lost its result (a crash): it can be retried. */
export const STALE_PENDING_MS = 2 * 60_000;

const ERROR_MAX = 500;

const exceedsPaid = () => new CheckoutError(HttpStatus.CONFLICT, 'refund_exceeds_paid');
const notRetryable = () => new CheckoutError(HttpStatus.CONFLICT, 'invalid_transition');

/**
 * Refunds through the `PaymentProvider` (spec §4.3, decision 74). Two short transactions around the provider call,
 * which runs outside any transaction:
 *  1. lock the order, check `1 ≤ amount ≤ refundable` and insert a PENDING row with the key `refund:<id>`;
 *  2. lock the order again and settle: SUCCEEDED adds to `refundedTotal`, FAILED stores the error and flags the order.
 * The pending row counts against what can be refunded, so concurrent refunds can never exceed what was paid; the
 * same key makes a retry safe at the provider.
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(PAYMENT_PROVIDER) private readonly provider: PaymentProvider,
  ) {}

  /** What can still be refunded on an order, read inside `tx` (the caller holds the order lock for a decision). */
  async state(tx: Prisma.TransactionClient, orderId: string) {
    const order = await tx.order.findUniqueOrThrow({
      where: { id: orderId },
      select: {
        total: true,
        refundedTotal: true,
        payments: { select: { status: true, amount: true } },
        refunds: { select: { status: true, amount: true } },
      },
    });
    return orderRefundState(order);
  }

  /**
   * Transaction 1, inside the caller's transaction with the order already locked: checks the amount and inserts the
   * PENDING row. `'full'` takes everything refundable. 409 `refund_exceeds_paid` when it does not fit.
   */
  async reserve(
    tx: Prisma.TransactionClient,
    orderId: string,
    amount: number | 'full',
    reason: string,
    adminId: number | null,
  ): Promise<Refund> {
    const { refundable } = await this.state(tx, orderId);
    const value = amount === 'full' ? refundable : amount;
    if (value < 1 || value > refundable) throw exceedsPaid();
    const payment = await this.paymentFor(tx, orderId, value);
    const id = randomUUID();
    return tx.refund.create({
      data: {
        id,
        orderId,
        paymentId: payment.id,
        amount: value,
        reason,
        adminUserId: adminId,
        provider: payment.provider,
        idempotencyKey: `refund:${id}`,
      },
    });
  }

  /** The latest succeeded payment that still has `amount` left (its amount minus its pending and succeeded refunds). */
  private async paymentFor(tx: Prisma.TransactionClient, orderId: string, amount: number) {
    const payments = await tx.payment.findMany({
      where: { orderId, status: PaymentStatus.SUCCEEDED },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: { refunds: { where: { status: { not: RefundStatus.FAILED } }, select: { amount: true } } },
    });
    const payment = payments.find((p) => p.amount - p.refunds.reduce((sum, r) => sum + r.amount, 0) >= amount);
    if (!payment) throw exceedsPaid();
    return payment;
  }

  /** A refund of `amount` agorot against the order's payment, made at the provider before this returns. */
  async create(
    orderId: string,
    amount: number | 'full',
    reason: string,
    adminId: number | null,
    ip?: string,
  ): Promise<Refund> {
    const refund = await this.prisma.$transaction(async (tx) => {
      if (!(await lockOrder(tx, orderId))) throw orderNotFound();
      return this.reserve(tx, orderId, amount, reason, adminId);
    });
    return this.execute(refund.id, ip);
  }

  /** Refunds everything refundable (a late payment on a cancelled order, spec §4.2). */
  refundFull(orderId: string, reason: string): Promise<Refund> {
    return this.create(orderId, 'full', reason, null);
  }

  /**
   * Calls the provider for a PENDING refund (outside any transaction) and settles it. A provider that throws counts
   * as a failure: the row ends FAILED and the order is flagged, never left PENDING by an exception.
   */
  async execute(refundId: string, ip?: string): Promise<Refund> {
    const refund = await this.prisma.refund.findUniqueOrThrow({
      where: { id: refundId },
      include: { payment: { select: { transactionId: true } } },
    });
    if (refund.status === RefundStatus.SUCCEEDED) return refund;
    let result: RefundResult;
    try {
      result = await this.provider.refund({
        transactionId: refund.payment.transactionId,
        amount: refund.amount,
        idempotencyKey: refund.idempotencyKey,
      });
    } catch (error) {
      this.logger.error(`Refund ${refund.id} threw at the provider`, error);
      result = { providerRefundId: '', status: 'failed', error: error instanceof Error ? error.message : 'error' };
    }
    return this.settle(refund.id, result, ip);
  }

  /**
   * Retry of a FAILED refund, or of a PENDING one that lost its result (older than `STALE_PENDING_MS`), with the
   * same idempotency key. A FAILED one is checked against what is refundable now; it goes back to PENDING first, so
   * a second retry at the same moment finds it in flight (409).
   */
  async retry(refundId: string, ip?: string): Promise<Refund> {
    const found = await this.prisma.refund.findUnique({ where: { id: refundId }, select: { orderId: true } });
    if (!found) throw orderNotFound();
    await this.prisma.$transaction(async (tx) => {
      await lockOrder(tx, found.orderId);
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status === RefundStatus.SUCCEEDED) throw notRetryable();
      if (refund.status === RefundStatus.PENDING) {
        if (Date.now() - refund.updatedAt.getTime() < STALE_PENDING_MS) throw notRetryable();
      } else {
        const { refundable } = await this.state(tx, refund.orderId);
        if (refund.amount > refundable) throw exceedsPaid();
        await this.paymentFor(tx, refund.orderId, refund.amount);
      }
      // Also restarts the stale clock of a PENDING one.
      await tx.refund.update({ where: { id: refund.id }, data: { status: RefundStatus.PENDING, error: null } });
    });
    return this.execute(refundId, ip);
  }

  /** Transaction 2: the result under the order lock. Settling twice (two retries) changes the order once. */
  private async settle(refundId: string, result: RefundResult, ip?: string): Promise<Refund> {
    return this.prisma.$transaction(async (tx) => {
      const { orderId } = await tx.refund.findUniqueOrThrow({ where: { id: refundId }, select: { orderId: true } });
      await lockOrder(tx, orderId);
      const refund = await tx.refund.findUniqueOrThrow({ where: { id: refundId } });
      if (refund.status === RefundStatus.SUCCEEDED) return refund;

      if (result.status === 'succeeded') {
        const settled = await tx.refund.update({
          where: { id: refund.id },
          data: { status: RefundStatus.SUCCEEDED, providerRefundId: result.providerRefundId, error: null },
        });
        const order = await tx.order.update({
          where: { id: orderId },
          data: { refundedTotal: { increment: refund.amount } },
        });
        // The flag of a failed refund goes once none is left failed; other notes (a late payment) stay for staff.
        if (order.needsAttention && order.attentionNote === REFUND_FAILED_NOTE) {
          const stillFailed = await tx.refund.count({ where: { orderId, status: RefundStatus.FAILED } });
          if (stillFailed === 0)
            await tx.order.update({ where: { id: orderId }, data: { needsAttention: false, attentionNote: null } });
        }
        await this.audit.record(
          {
            actorId: refund.adminUserId,
            action: 'order.refund',
            entityType: 'order',
            entityId: order.number,
            before: { refundedTotal: order.refundedTotal - refund.amount },
            after: {
              refundedTotal: order.refundedTotal,
              refundId: refund.id,
              amount: refund.amount,
              reason: refund.reason,
              provider: refund.provider,
            },
            ip,
          },
          tx,
        );
        await this.onRefundSucceeded(tx, settled);
        return settled;
      }

      const settled = await tx.refund.update({
        where: { id: refund.id },
        data: {
          status: RefundStatus.FAILED,
          providerRefundId: result.providerRefundId || refund.providerRefundId,
          error: (result.error ?? 'refund failed').slice(0, ERROR_MAX),
        },
      });
      const order = await tx.order.update({
        where: { id: orderId },
        data: { needsAttention: true, attentionNote: REFUND_FAILED_NOTE },
      });
      await this.audit.record(
        {
          actorId: refund.adminUserId,
          action: 'order.refund_failed',
          entityType: 'order',
          entityId: order.number,
          after: { refundId: refund.id, amount: refund.amount, reason: refund.reason, provider: refund.provider },
          ip,
        },
        tx,
      );
      return settled;
    });
  }

  /** Hook for the credit note and notifications of later tasks; runs in the transaction that records the refund. */
  protected onRefundSucceeded(_tx: Prisma.TransactionClient, _refund: Refund): Promise<void> {
    return Promise.resolve();
  }
}
