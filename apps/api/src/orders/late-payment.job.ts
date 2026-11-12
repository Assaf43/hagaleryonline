import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { OutboxService } from '../outbox/outbox.service.js';
import { CheckoutError } from './order-errors.js';
import { RefundService } from './refund.service.js';

/** Payload of `refund.late_payment:<paymentId>`, enqueued by the payment webhook (spec §4.2). */
export interface LatePaymentJob {
  orderId: string;
  paymentId: string;
  /** Agorot: the late payment's own amount. */
  amount: number;
}

/**
 * Handler of the outbox job `refund.late_payment` (decision 83): refunds a payment that succeeded after its order
 * was cancelled. A refund the provider refuses ends FAILED with the order flagged ("נסה שוב" on the order page), as
 * in 5a; one that does not fit what is refundable leaves the "refund by hand" note. Both finish the job. A refund of
 * this payment still in flight (PENDING, not yet stale) and unexpected errors (the database) retry it.
 */
@Injectable()
export class LatePaymentRefundJob implements OnModuleInit {
  private readonly logger = new Logger(LatePaymentRefundJob.name);

  constructor(
    private readonly outbox: OutboxService,
    private readonly refunds: RefundService,
  ) {}

  onModuleInit(): void {
    this.outbox.register<LatePaymentJob>('refund.late_payment', (payload) => this.run(payload));
  }

  async run({ orderId, paymentId, amount }: LatePaymentJob): Promise<void> {
    try {
      await this.refunds.refundLatePayment(orderId, paymentId, amount);
    } catch (error) {
      if (error instanceof CheckoutError && error.code === 'refund_exceeds_paid') {
        this.logger.warn(
          `The late payment ${paymentId} of order ${orderId} cannot be refunded here: refund it by hand`,
        );
        return;
      }
      throw error;
    }
  }
}
