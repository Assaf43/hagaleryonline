import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

const TIMEOUT_MS = 10_000;

/**
 * Delivers a webhook the sandbox built to our own webhook endpoint, so it goes through the same code path (raw body,
 * signature check) as a real provider's call (spec §5.3). Injectable so a test or a later setup can replace it.
 */
export abstract class WebhookDispatcher {
  /** Resolves with the HTTP status of the webhook endpoint. */
  abstract deliver(body: string, headers: Record<string, string>): Promise<number>;
}

/** POSTs to `${API_INTERNAL_URL}/api/payments/webhook` (default http://localhost:3000). */
@Injectable()
export class HttpWebhookDispatcher extends WebhookDispatcher {
  constructor(private readonly config: ConfigService) {
    super();
  }

  async deliver(body: string, headers: Record<string, string>): Promise<number> {
    // Read on every call: the e2e tests learn their port only after the app listens.
    const base = (this.config.get<string>('API_INTERNAL_URL') || 'http://localhost:3000').replace(/\/+$/, '');
    const res = await fetch(`${base}/api/payments/webhook`, {
      method: 'POST',
      headers,
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    await res.body?.cancel();
    return res.status;
  }
}
