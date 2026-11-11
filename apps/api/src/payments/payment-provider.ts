import type { IncomingHttpHeaders } from 'node:http';

/** What a provider needs to open a payment page for an order (never card data, NFR-10). */
export interface OrderSummary {
  orderId: string;
  orderNumber: number;
  /** Agorot, VAT included: the order total. */
  amount: number;
  customer: { fullName: string; phone: string; email: string };
}

/** The outcome a provider reports for one transaction. */
export type PaymentOutcome = 'succeeded' | 'failed' | 'cancelled';

/** A verified webhook (spec §5.4). */
export interface PaymentResult {
  transactionId: string;
  status: PaymentOutcome;
  /** Agorot, as charged by the provider. */
  amount: number;
  installments: number | null;
  /** The provider's own status text, kept on the payment row. */
  rawStatus: string;
}

/**
 * A payment provider (architecture.md §6, spec §5.3). Every provider is its own adapter; business code talks only
 * to this interface. `code` is stored with each order and payment. Card details never reach this server: the
 * customer pays on the provider's page and the result arrives by webhook.
 */
export interface PaymentProvider {
  readonly code: string;
  /** True for the sandbox: no real money moves (shown in the admin, ADM-13). */
  readonly testMode: boolean;
  createPaymentPage(order: OrderSummary): Promise<{ redirectUrl: string; transactionId: string }>;
  /** Throws WebhookSignatureError when the signature is wrong and WebhookPayloadError when the body makes no sense. */
  verifyWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<PaymentResult>;
}

/** Injection token of the active provider, chosen by the `PAYMENT_PROVIDER` env variable (required, no default). */
export const PAYMENT_PROVIDER = 'PAYMENT_PROVIDER';

export class WebhookSignatureError extends Error {
  constructor() {
    super('Invalid webhook signature');
    this.name = 'WebhookSignatureError';
  }
}

export class WebhookPayloadError extends Error {
  constructor(reason: string) {
    super(`Invalid webhook payload: ${reason}`);
    this.name = 'WebhookPayloadError';
  }
}

/**
 * The adapter named by `code` (required: empty stops the API at startup). Adapters are built lazily, so one that refuses to load (the
 * sandbox in production) only stops the API when it is the one selected; an unknown code fails at startup.
 */
export function selectPaymentProvider(
  code: string | undefined,
  factories: Record<string, () => PaymentProvider>,
): PaymentProvider {
  // No default: a box that forgot the variable must not quietly take payments in the sandbox (free orders).
  const wanted = code?.trim();
  if (!wanted) throw new Error(`PAYMENT_PROVIDER is not set. Expected one of: ${Object.keys(factories).join(', ')}.`);
  const factory = Object.hasOwn(factories, wanted) ? factories[wanted] : undefined;
  if (!factory)
    throw new Error(`Unknown PAYMENT_PROVIDER "${wanted}". Expected one of: ${Object.keys(factories).join(', ')}.`);
  return factory();
}
