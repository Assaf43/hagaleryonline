import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  WebhookPayloadError,
  WebhookSignatureError,
  type OrderSummary,
  type PaymentOutcome,
  type PaymentProvider,
  type PaymentResult,
} from './payment-provider.js';
import { SANDBOX_SIGNATURE_HEADER, sign, verify } from './webhook-signature.js';

export const SANDBOX_CODE = 'sandbox';

/** The body the sandbox webhook carries (signed as a whole). */
export interface SandboxWebhookPayload {
  transactionId: string;
  status: PaymentOutcome;
  amount: number;
  installments: number;
}

const OUTCOMES: readonly PaymentOutcome[] = ['succeeded', 'failed', 'cancelled'];

/**
 * `sandbox` adapter (development only, CHK-10, spec §5.3): the "payment page" is the storefront's
 * /pay/sandbox/:transactionId, and the result comes back as a webhook signed with HMAC-SHA256
 * (`PAYMENT_SANDBOX_SECRET`). It refuses to load when NODE_ENV=production, and on a public site address unless
 * `PAYMENT_SANDBOX_ALLOW_REMOTE=true` (a test environment such as staging).
 */
export class SandboxPaymentProvider implements PaymentProvider {
  readonly code = SANDBOX_CODE;
  readonly testMode = true;
  private readonly secret: string;
  private readonly siteUrl: string;

  constructor(config: ConfigService) {
    if (config.get<string>('NODE_ENV') === 'production')
      throw new Error('PAYMENT_PROVIDER=sandbox cannot run in production: choose a real payment provider.');
    const site = config.get<string>('SITE_URL') || config.get<string>('STOREFRONT_URL') || 'http://localhost:4200';
    // Anyone can mark a sandbox payment paid, so on a public address (a production box without NODE_ENV) it would
    // give orders away. A test environment on a real host must say so explicitly.
    if (!isDevelopmentAddress(site) && config.get<string>('PAYMENT_SANDBOX_ALLOW_REMOTE') !== 'true')
      throw new Error(
        `PAYMENT_PROVIDER=sandbox refuses the public site address ${site}. ` +
          'On a test environment set PAYMENT_SANDBOX_ALLOW_REMOTE=true; otherwise choose a real payment provider.',
      );
    const secret = config.get<string>('PAYMENT_SANDBOX_SECRET')?.trim();
    if (!secret)
      new Logger(SandboxPaymentProvider.name).warn(
        'PAYMENT_SANDBOX_SECRET is not set: using a random secret for this process only',
      );
    this.secret = secret || randomBytes(32).toString('hex');
    this.siteUrl = site.replace(/\/+$/, '');
  }

  createPaymentPage(order: OrderSummary): Promise<{ redirectUrl: string; transactionId: string }> {
    void order;
    const transactionId = `sbx_${randomBytes(16).toString('hex')}`;
    return Promise.resolve({ transactionId, redirectUrl: `${this.siteUrl}/pay/sandbox/${transactionId}` });
  }

  /** The signed webhook a real provider would send: the body and its headers. */
  signedWebhook(payload: SandboxWebhookPayload): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify(payload);
    return {
      body,
      headers: { 'content-type': 'application/json', [SANDBOX_SIGNATURE_HEADER]: sign(body, this.secret) },
    };
  }

  verifyWebhook(headers: IncomingHttpHeaders, rawBody: Buffer): Promise<PaymentResult> {
    // Check the signature over the exact bytes before reading anything from the body.
    if (!verify(rawBody, headers[SANDBOX_SIGNATURE_HEADER], this.secret))
      return Promise.reject(new WebhookSignatureError());
    try {
      return Promise.resolve(parsePayload(rawBody));
    } catch (e) {
      return Promise.reject(e instanceof WebhookPayloadError ? e : new WebhookPayloadError('not JSON'));
    }
  }
}

/** A local development host: localhost, a loopback address, or a name ending in .localhost or .test. */
function isDevelopmentAddress(site: string): boolean {
  let host: string;
  try {
    host = new URL(site).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]' ||
    host.endsWith('.localhost') ||
    host.endsWith('.test')
  );
}

function parsePayload(rawBody: Buffer): PaymentResult {
  const data: unknown = JSON.parse(rawBody.toString('utf8'));
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new WebhookPayloadError('not an object');
  const { transactionId, status, amount, installments } = data as Record<string, unknown>;
  if (typeof transactionId !== 'string' || transactionId.length < 1 || transactionId.length > 100)
    throw new WebhookPayloadError('transactionId');
  if (typeof status !== 'string' || !OUTCOMES.includes(status as PaymentOutcome))
    throw new WebhookPayloadError('status');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 0)
    throw new WebhookPayloadError('amount');
  if (
    installments !== undefined &&
    installments !== null &&
    (typeof installments !== 'number' || !Number.isInteger(installments) || installments < 1 || installments > 12)
  )
    throw new WebhookPayloadError('installments');
  return {
    transactionId,
    status: status as PaymentOutcome,
    amount,
    installments: (installments as number | null | undefined) ?? null,
    rawStatus: status,
  };
}
