/** A tag of a synced contact: `member` when linked to an account, else `newsletter` (spec §5.4). */
export type MarketingTag = 'member' | 'newsletter';

/** What the e-mail tool keeps of a subscribed contact (spec §5.4). Only `subscribed` contacts are ever sent. */
export interface SyncedContact {
  email: string;
  /** The first word of the linked account's name; null for a newsletter contact. */
  firstName: string | null;
  tags: MarketingTag[];
  hasPurchased: boolean;
  /** ISO time of the latest paid order, null without one. */
  lastPaidOrderAt: string | null;
  /** Top-level category slugs of the paid orders' products (favorites are added in Phase 7c). */
  interestCategories: string[];
}

/** An event the e-mail tool reports through its signed webhook. Only unsubscribes for now. */
export interface MarketingWebhookEvent {
  /** The tool's own event id: the same id again records nothing. */
  id: string;
  type: 'unsubscribed';
  email: string;
}

/**
 * The e-mail marketing tool (CLAUDE.md §4.2, spec §5.4, CLB-11). Business code talks only to this interface; the
 * active adapter comes from `MARKETING_PROVIDER` (required, no default). Calls must be idempotent: the outbox may run
 * a sync job more than once.
 */
export interface MarketingProvider {
  readonly code: string;
  /** Adds the contact or updates its fields (matched by e-mail). */
  upsertContact(contact: SyncedContact): Promise<void>;
  /** Removes the contact; an unknown address is not an error. */
  removeContact(email: string): Promise<void>;
  /**
   * The events of a webhook call. Throws `MarketingWebhookSignatureError` when the signature over the exact raw body is
   * wrong, and `MarketingWebhookPayloadError` when the signed body makes no sense.
   */
  verifyWebhook(raw: Buffer, headers: Record<string, string | string[] | undefined>): MarketingWebhookEvent[];
}

/** Injection token of the active provider, chosen by `MARKETING_PROVIDER` (required, no default). */
export const MARKETING_PROVIDER = 'MARKETING_PROVIDER';

export class MarketingWebhookSignatureError extends Error {
  constructor() {
    super('Invalid marketing webhook signature');
    this.name = 'MarketingWebhookSignatureError';
  }
}

export class MarketingWebhookPayloadError extends Error {
  constructor(reason: string) {
    super(`Invalid marketing webhook payload: ${reason}`);
    this.name = 'MarketingWebhookPayloadError';
  }
}
