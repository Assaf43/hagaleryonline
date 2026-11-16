import { randomBytes } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { maskEmail } from '../notifications/masking.js';
import { sign, verify } from '../payments/webhook-signature.js';
import {
  MarketingWebhookPayloadError,
  MarketingWebhookSignatureError,
  type MarketingProvider,
  type MarketingWebhookEvent,
  type SyncedContact,
} from './marketing-provider.js';

export const MOCK_MARKETING_CODE = 'mock';
/** Header that carries the mock webhook signature (hex HMAC-SHA256 of the raw body). */
export const MOCK_MARKETING_SIGNATURE_HEADER = 'x-mock-marketing-signature';

const EVENT_ID_MAX = 200;
const EMAIL_MAX = 254;

/**
 * `mock` adapter (development and e2e only, spec §5.4): keeps the synced list in this process's memory (lost on
 * restart) and logs each call with a masked address. Its webhook is a JSON body `{ events: [...] }` signed with
 * HMAC-SHA256 under `MARKETING_MOCK_SECRET` (a random secret per process when empty). Refuses NODE_ENV=production.
 */
export class MockMarketingProvider implements MarketingProvider {
  readonly code = MOCK_MARKETING_CODE;
  private readonly logger = new Logger(MockMarketingProvider.name);
  private readonly contacts = new Map<string, SyncedContact>();
  private readonly secret: string;

  constructor(config: ConfigService) {
    if (config.get<string>('NODE_ENV') === 'production')
      throw new Error('MARKETING_PROVIDER = mock cannot run in production: choose a real e-mail marketing tool.');
    const secret = config.get<string>('MARKETING_MOCK_SECRET')?.trim();
    if (!secret) this.logger.warn('MARKETING_MOCK_SECRET is not set: using a random secret for this process only');
    this.secret = secret || randomBytes(32).toString('hex');
  }

  upsertContact(contact: SyncedContact): Promise<void> {
    this.contacts.set(contact.email, structuredClone(contact));
    this.logger.log(`upsert ${maskEmail(contact.email)} [${contact.tags.join(', ')}]`);
    return Promise.resolve();
  }

  removeContact(email: string): Promise<void> {
    const removed = this.contacts.delete(email);
    this.logger.log(`remove ${maskEmail(email)}${removed ? '' : ' (not in the list)'}`);
    return Promise.resolve();
  }

  /** The synced list (the dev view), by e-mail. */
  list(): SyncedContact[] {
    return [...this.contacts.values()].sort((a, b) => a.email.localeCompare(b.email)).map((c) => structuredClone(c));
  }

  sign(body: string | Buffer): string {
    return sign(body, this.secret);
  }

  /** The signed webhook the tool would send: the body and its headers (the dev "unsubscribe" action uses it). */
  signedWebhook(events: MarketingWebhookEvent[]): { body: string; headers: Record<string, string> } {
    const body = JSON.stringify({ events });
    return {
      body,
      headers: { 'content-type': 'application/json', [MOCK_MARKETING_SIGNATURE_HEADER]: this.sign(body) },
    };
  }

  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): MarketingWebhookEvent[] {
    if (!verify(raw, headers[MOCK_MARKETING_SIGNATURE_HEADER], this.secret)) throw new MarketingWebhookSignatureError();
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new MarketingWebhookPayloadError('not JSON');
    }
    const events = (parsed as { events?: unknown } | null)?.events;
    if (!Array.isArray(events)) throw new MarketingWebhookPayloadError('events');
    return events.map((e: unknown, i) => {
      const { id, type, email } = (e ?? {}) as Record<string, unknown>;
      if (typeof id !== 'string' || id.length === 0 || id.length > EVENT_ID_MAX)
        throw new MarketingWebhookPayloadError(`events.${i}.id`);
      if (type !== 'unsubscribed') throw new MarketingWebhookPayloadError(`events.${i}.type`);
      if (typeof email !== 'string' || !email.includes('@') || email.length > EMAIL_MAX)
        throw new MarketingWebhookPayloadError(`events.${i}.email`);
      return { id, type, email };
    });
  }
}
