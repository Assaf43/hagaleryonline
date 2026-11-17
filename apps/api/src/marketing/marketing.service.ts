import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  CONSENT_TEXT_VERSION,
  type AccountConsent,
  type MarketingConsentSource as SourceView,
  type MarketingStatus as StatusView,
} from '@hg/models';
import { hashToken } from '../auth/crypto.js';
import {
  ConsentAction,
  MarketingConsentSource,
  MarketingStatus,
  Prisma,
  type MarketingContact,
} from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { UnsubscribeTokens } from './marketing-tokens.js';

/** Who made a consent change, for the history (each field only when known). */
export interface ConsentActor {
  customerId?: string | null;
  sellerId?: number | null;
  ip?: string | null;
}

export interface ConsentMeta {
  ip?: string | null;
}

export type ConfirmationResult = 'sent' | 'already_subscribed' | 'throttled';

/** At most this many confirmation requests (`requested` events) per address in 24 hours (spec §6). */
export const MAX_REQUESTS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60_000;
/** Longer than any token we issue: refused before hashing. */
const TOKEN_MAX = 128;

export const SOURCE_DB: Record<SourceView, MarketingConsentSource> = {
  signup: MarketingConsentSource.SIGNUP,
  checkout: MarketingConsentSource.CHECKOUT,
  account: MarketingConsentSource.ACCOUNT,
  store: MarketingConsentSource.STORE,
  newsletter: MarketingConsentSource.NEWSLETTER,
};
const SOURCE_VIEW = Object.fromEntries(Object.entries(SOURCE_DB).map(([k, v]) => [v, k])) as Record<
  MarketingConsentSource,
  SourceView
>;
export const STATUS_VIEW: Record<MarketingStatus, StatusView> = {
  PENDING: 'pending',
  SUBSCRIBED: 'subscribed',
  UNSUBSCRIBED: 'unsubscribed',
};

type Db = Prisma.TransactionClient;
interface ContactState {
  status: MarketingStatus;
  source: MarketingConsentSource;
  consentAt?: Date | null;
  unsubscribedAt?: Date | null;
  confirmTokenHash?: string | null;
  confirmExpiresAt?: Date | null;
}

const normalize = (email: string) => email.trim().toLowerCase();

/** A contact whose confirmation link still works: pending, with a token that has not expired. */
const isLiveConfirmation = (c: MarketingContact): boolean =>
  c.status === MarketingStatus.PENDING &&
  c.confirmTokenHash !== null &&
  c.confirmExpiresAt !== null &&
  c.confirmExpiresAt.getTime() > Date.now();

/**
 * One transaction-scoped advisory lock per e-mail: every change of a contact takes it first, so two changes of one
 * address run one after the other (and two first requests make one contact). It is the LAST lock of any transaction
 * that takes it (locks.ts): while holding it this service only writes marketing rows and the outbox.
 */
async function lockEmail(tx: Db, email: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'marketing:' + email}::text))`;
}

/**
 * Marketing consent, in one place (spec §5.3, CLB-02, CLB-08, ACC-05, decisions 95–96): one contact per e-mail holds
 * the current state, and every change writes one append-only `marketing_consent_events` row (who, when, which text
 * version, from where). Rules: a verified e-mail subscribes at once (`subscribeVerified`); any other consent waits for a
 * link (`requestConfirmation` → `confirm`); withdrawals, link and provider unsubscribes, and the release of an e-mail
 * that leaves its account end it. A contact is linked (`customerId`) to the account that holds its e-mail verified.
 *
 * Every status change bumps `syncVersion` and enqueues `marketing.sync` (`{ contactId, version }`, dedupe key
 * `marketing.sync:<contactId>:<version>`) in the same transaction; its handler reads the contact when it runs. The
 * confirmation messages are outbox jobs too: their handler makes the confirmation token, so the raw token is never
 * stored anywhere (only its hash, on the contact) — see `MarketingMessagesJob`.
 */
@Injectable()
export class MarketingService {
  private readonly logger = new Logger(MarketingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly tokens: UnsubscribeTokens,
  ) {}

  /** A verified e-mail (sign-up, the account page, a signed-in checkout with it): `subscribed` now. Repeats: no change. */
  async subscribeVerified(
    tx: Db,
    input: { email: string; customerId: string; source: SourceView; actor: ConsentActor },
  ): Promise<void> {
    const email = normalize(input.email);
    await lockEmail(tx, email);
    const found = await tx.marketingContact.findUnique({ where: { email } });
    if (found?.status === MarketingStatus.SUBSCRIBED) {
      await this.link(tx, found, input.customerId);
      return;
    }
    const source = SOURCE_DB[input.source];
    const contact = await this.save(tx, found, email, input.customerId, {
      status: MarketingStatus.SUBSCRIBED,
      source,
      consentAt: new Date(),
      unsubscribedAt: null,
      confirmTokenHash: null,
      confirmExpiresAt: null,
    });
    await this.event(tx, contact.id, ConsentAction.CONFIRMED, source, input.actor);
    await this.sync(tx, contact);
  }

  /**
   * A consent that needs the customer's confirmation (guest checkout, the newsletter form, the store seller): the
   * contact becomes `pending`, a `requested` event is written and the message with the link is enqueued — an e-mail
   * (`email.newsletter_confirm`) or an SMS to `phone` (`sms.store_consent`). An already subscribed address gets no
   * event and no message; over `MAX_REQUESTS_PER_DAY` requests in 24 hours the request is dropped. The caller answers
   * the same whatever the result. The contact is linked to `customerId`, else to the account holding the e-mail verified.
   */
  async requestConfirmation(
    tx: Db,
    input: {
      email: string;
      customerId?: string | null;
      source: SourceView;
      channel: 'email' | 'sms';
      phone?: string;
      actor: ConsentActor;
    },
  ): Promise<ConfirmationResult> {
    if (input.channel === 'sms' && !input.phone) throw new Error('An SMS confirmation request needs the phone');
    const email = normalize(input.email);
    await lockEmail(tx, email);
    const found = await tx.marketingContact.findUnique({ where: { email } });
    const owner = input.customerId ?? (await this.verifiedHolder(tx, email));
    if (found?.status === MarketingStatus.SUBSCRIBED) {
      if (owner) await this.link(tx, found, owner);
      return 'already_subscribed';
    }
    if (found) {
      const recent = await tx.marketingConsentEvent.count({
        where: { contactId: found.id, action: ConsentAction.REQUESTED, at: { gte: new Date(Date.now() - DAY_MS) } },
      });
      if (recent >= MAX_REQUESTS_PER_DAY) return 'throttled';
    }
    const source = SOURCE_DB[input.source];
    const contact = await this.save(tx, found, email, owner, {
      status: MarketingStatus.PENDING,
      source,
      consentAt: null,
    });
    // A seller-made request (the store box) shows the customer no text: its event records none. The text they agree
    // to is on the link page, so the `confirmed` event after their click carries the version.
    const textShown = input.source !== 'store';
    const event = await this.event(tx, contact.id, ConsentAction.REQUESTED, source, input.actor, { textShown });
    const key = String(event.id);
    await this.outbox.enqueue(
      tx,
      input.channel === 'email'
        ? {
            type: 'email.newsletter_confirm',
            dedupeKey: `email.newsletter_confirm:${key}`,
            payload: { contactId: contact.id },
          }
        : {
            type: 'sms.store_consent',
            dedupeKey: `sms.store_consent:${key}`,
            payload: { contactId: contact.id, phone: input.phone },
          },
    );
    if (found?.status !== MarketingStatus.PENDING) await this.sync(tx, contact);
    return 'sent';
  }

  /**
   * The link page's first, read-only call (`/newsletter/confirm?t=` on load): the address of a `pending` contact whose
   * token is live, so the page can name it next to the consent text and ask for the click. Changes nothing and never
   * uses the token: a mail scanner that opens the link confirms nothing. Unknown, used or expired → null.
   */
  async previewConfirmation(token: string): Promise<{ email: string } | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX) return null;
    const contact = await this.prisma.marketingContact.findUnique({ where: { confirmTokenHash: hashToken(token) } });
    return contact && isLiveConfirmation(contact) ? { email: contact.email } : null;
  }

  /**
   * The customer's click on the link page (`/newsletter/confirm?t=`): a `pending` contact whose token is live becomes `subscribed`
   * with a `confirmed` event, and the token is cleared (the link works once). Unknown, used or expired → null.
   */
  async confirm(token: string, meta: ConsentMeta): Promise<{ email: string } | null> {
    if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX) return null;
    const hash = hashToken(token);
    return this.prisma.$transaction(async (tx) => {
      const seen = await tx.marketingContact.findUnique({ where: { confirmTokenHash: hash } });
      if (!seen) return null;
      await lockEmail(tx, seen.email);
      const contact = await tx.marketingContact.findUnique({ where: { id: seen.id } });
      if (!contact || contact.confirmTokenHash !== hash || !isLiveConfirmation(contact)) return null;
      const updated = await tx.marketingContact.update({
        where: { id: contact.id },
        data: {
          status: MarketingStatus.SUBSCRIBED,
          consentAt: new Date(),
          unsubscribedAt: null,
          confirmTokenHash: null,
          confirmExpiresAt: null,
          syncVersion: { increment: 1 },
        },
      });
      await this.event(tx, contact.id, ConsentAction.CONFIRMED, contact.source, { ip: meta.ip });
      await this.sync(tx, updated);
      return { email: contact.email };
    });
  }

  /** The customer withdraws (the account page): `unsubscribed` with a `withdrawn` event. Nothing to end: no change. */
  async withdraw(tx: Db, input: { email: string; source: SourceView; actor: ConsentActor }): Promise<void> {
    const email = normalize(input.email);
    await lockEmail(tx, email);
    const found = await tx.marketingContact.findUnique({ where: { email } });
    if (!found || found.status === MarketingStatus.UNSUBSCRIBED) return;
    await this.unsubscribe(tx, found, ConsentAction.WITHDRAWN, SOURCE_DB[input.source], input.actor);
  }

  /** The unsubscribe link of our messages (`/newsletter/unsubscribe?t=`): as `withdraw`. Unknown token: nothing. */
  async unsubscribeByToken(token: string, meta: ConsentMeta): Promise<void> {
    if (typeof token !== 'string' || token.length === 0 || token.length > TOKEN_MAX) return;
    const hash = hashToken(token);
    await this.prisma.$transaction(async (tx) => {
      const seen = await tx.marketingContact.findUnique({ where: { unsubscribeTokenHash: hash } });
      if (!seen) return;
      await lockEmail(tx, seen.email);
      const contact = await tx.marketingContact.findUnique({ where: { id: seen.id } });
      if (!contact || contact.unsubscribeTokenHash !== hash || contact.status === MarketingStatus.UNSUBSCRIBED) return;
      await this.unsubscribe(tx, contact, ConsentAction.WITHDRAWN, null, { ip: meta.ip });
    });
  }

  /**
   * The e-mail tool reports an unsubscribe (Task 3 webhook): `unsubscribed` with a `provider_unsubscribed` event that
   * keeps the tool's event id. The same event id again records nothing (unique `provider_event_id`).
   */
  async providerUnsubscribed(email: string, eventId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        if (await tx.marketingConsentEvent.findUnique({ where: { providerEventId: eventId } })) return;
        const address = normalize(email);
        await lockEmail(tx, address);
        const found = await tx.marketingContact.findUnique({ where: { email: address } });
        if (!found) return;
        if (found.status === MarketingStatus.UNSUBSCRIBED) {
          await this.event(tx, found.id, ConsentAction.PROVIDER_UNSUBSCRIBED, null, {}, { providerEventId: eventId });
          return;
        }
        await this.unsubscribe(tx, found, ConsentAction.PROVIDER_UNSUBSCRIBED, null, {}, { providerEventId: eventId });
      });
    } catch (error) {
      // The same event delivered twice at once: the second insert hits the unique event id.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return;
      throw error;
    }
  }

  /**
   * The e-mail leaves its account (spec §5.3, writer's call): a website sign-up takes an unverified e-mail
   * (`released`), or the account changes its e-mail (`changed`). The consent never moves to the new owner: a
   * subscribed or pending contact becomes `unsubscribed`; the contact is unlinked; a `released` event either way.
   */
  async releaseEmail(tx: Db, email: string, reason: 'released' | 'changed'): Promise<void> {
    const address = normalize(email);
    await lockEmail(tx, address);
    const found = await tx.marketingContact.findUnique({ where: { email: address } });
    if (!found) return;
    if (found.status === MarketingStatus.UNSUBSCRIBED) {
      if (found.customerId) await tx.marketingContact.update({ where: { id: found.id }, data: { customerId: null } });
      await this.event(tx, found.id, ConsentAction.RELEASED, null, {});
    } else {
      await this.unsubscribe(tx, found, ConsentAction.RELEASED, null, {}, { unlink: true });
    }
    this.logger.log(`Marketing contact ${found.id} released (${reason})`);
  }

  /**
   * An account verified this e-mail (sign-up, `contact/confirm`): its contact, if any, is linked to the account. No
   * consent change and no event; a subscribed contact is synced again (it is a member now).
   */
  async linkVerifiedEmail(tx: Db, email: string, customerId: string): Promise<void> {
    const address = normalize(email);
    await lockEmail(tx, address);
    const found = await tx.marketingContact.findUnique({ where: { email: address } });
    if (found) await this.link(tx, found, customerId);
  }

  /**
   * An order of an account was paid (in the payment's transaction, as its last step): the synced fields of the
   * account's contact changed (has purchased, last paid order, interests), so a subscribed contact linked to it gets a
   * new `syncVersion` and a `marketing.sync` job. Only the account's own contact: purchase fields come from the
   * account's orders only (decision 77), so a guest order changes nobody's fields. A contact not subscribed is not in
   * the tool: nothing to do.
   */
  async orderPaid(tx: Db, order: { customerId: string | null }): Promise<void> {
    if (order.customerId) await this.fieldsChanged(tx, order.customerId);
  }

  /**
   * The favorites of an account changed (CLB-09; in the favorites transaction, as its last step): the interests of its
   * contact changed, so it is synced like after a payment. Nothing to do for an account without a subscribed contact.
   */
  async favoritesChanged(tx: Db, customerId: string): Promise<void> {
    await this.fieldsChanged(tx, customerId);
  }

  /** The synced fields of an account's contact changed: see `orderPaid`. */
  private async fieldsChanged(tx: Db, customerId: string): Promise<void> {
    const seen = await tx.marketingContact.findUnique({
      where: { customerId },
      select: { email: true },
    });
    if (!seen) return;
    await lockEmail(tx, seen.email);
    // Re-read under the lock, by the e-mail locked: the contact may have changed or been unlinked meanwhile. If the
    // account now links another e-mail's contact, that contact is not ours to change without its own lock: skip. The
    // change that re-linked it synced it already (a link of a subscribed contact enqueues a sync).
    const contact = await tx.marketingContact.findUnique({ where: { email: seen.email } });
    if (contact?.customerId !== customerId || contact.status !== MarketingStatus.SUBSCRIBED) return;
    const updated = await tx.marketingContact.update({
      where: { id: contact.id },
      data: { syncVersion: { increment: 1 } },
    });
    await this.sync(tx, updated);
  }

  /** The contact of an account: the linked one, else the one of its own e-mail (an unverified e-mail is still theirs). */
  async contactFor(customer: { id: string; email: string | null }): Promise<MarketingContact | null> {
    const linked = await this.prisma.marketingContact.findUnique({ where: { customerId: customer.id } });
    if (linked || !customer.email) return linked;
    return this.prisma.marketingContact.findUnique({ where: { email: customer.email } });
  }

  /** `GET /api/account/consent` (and the answer of `PUT`). */
  async consentView(customerId: string): Promise<AccountConsent> {
    const customer = await this.prisma.customer.findUniqueOrThrow({
      where: { id: customerId },
      select: { id: true, email: true, emailVerifiedAt: true },
    });
    const contact = await this.contactFor(customer);
    return {
      status: contact ? STATUS_VIEW[contact.status] : null,
      source: contact ? SOURCE_VIEW[contact.source] : null,
      consentAt: contact?.status === MarketingStatus.SUBSCRIBED ? (contact.consentAt?.toISOString() ?? null) : null,
      emailVerified: customer.email !== null && customer.emailVerifiedAt !== null,
    };
  }

  // ---------- Helpers ----------

  /** Creates the contact or changes its state; `syncVersion` moves only when the status does. */
  private async save(
    tx: Db,
    found: MarketingContact | null,
    email: string,
    customerId: string | null | undefined,
    state: ContactState,
  ): Promise<MarketingContact> {
    if (customerId) await this.unlinkOthers(tx, customerId, found?.id);
    if (!found) {
      const id = randomUUID();
      return tx.marketingContact.create({
        data: {
          ...state,
          id,
          email,
          customerId: customerId ?? null,
          unsubscribeTokenHash: this.tokens.hash(id),
          syncVersion: 1,
        },
      });
    }
    return tx.marketingContact.update({
      where: { id: found.id },
      data: {
        ...state,
        ...(customerId ? { customerId } : {}),
        ...(found.status !== state.status ? { syncVersion: { increment: 1 } } : {}),
      },
    });
  }

  private async unsubscribe(
    tx: Db,
    contact: MarketingContact,
    action: ConsentAction,
    source: MarketingConsentSource | null,
    actor: ConsentActor,
    opts: { unlink?: boolean; providerEventId?: string } = {},
  ): Promise<void> {
    const updated = await tx.marketingContact.update({
      where: { id: contact.id },
      data: {
        status: MarketingStatus.UNSUBSCRIBED,
        unsubscribedAt: new Date(),
        consentAt: null,
        confirmTokenHash: null,
        confirmExpiresAt: null,
        syncVersion: { increment: 1 },
        ...(opts.unlink ? { customerId: null } : {}),
      },
    });
    await this.event(tx, contact.id, action, source, actor, { providerEventId: opts.providerEventId });
    await this.sync(tx, updated);
  }

  private async link(tx: Db, contact: MarketingContact, customerId: string): Promise<void> {
    if (contact.customerId === customerId) return;
    await this.unlinkOthers(tx, customerId, contact.id);
    const subscribed = contact.status === MarketingStatus.SUBSCRIBED;
    const updated = await tx.marketingContact.update({
      where: { id: contact.id },
      data: { customerId, ...(subscribed ? { syncVersion: { increment: 1 } } : {}) },
    });
    if (subscribed) await this.sync(tx, updated);
  }

  /** `customerId` is unique: an account is linked to one contact, the one of its current e-mail. */
  private async unlinkOthers(tx: Db, customerId: string, keepId: string | undefined): Promise<void> {
    await tx.marketingContact.updateMany({
      where: keepId ? { customerId, id: { not: keepId } } : { customerId },
      data: { customerId: null },
    });
  }

  private async verifiedHolder(tx: Db, email: string): Promise<string | null> {
    const holder = await tx.customer.findFirst({
      where: { email, emailVerifiedAt: { not: null } },
      select: { id: true },
    });
    return holder?.id ?? null;
  }

  private event(
    tx: Db,
    contactId: string,
    action: ConsentAction,
    source: MarketingConsentSource | null,
    actor: ConsentActor,
    opts: { providerEventId?: string; textShown?: boolean } = {},
  ) {
    const { providerEventId, textShown = true } = opts;
    const consent = textShown && (action === ConsentAction.REQUESTED || action === ConsentAction.CONFIRMED);
    return tx.marketingConsentEvent.create({
      data: {
        contactId,
        action,
        source,
        // The checkbox text the customer agreed to; a withdrawal, a release or a seller-made request shows no text.
        textVersion: consent ? CONSENT_TEXT_VERSION : null,
        actorCustomerId: actor.customerId ?? null,
        actorSellerId: actor.sellerId ?? null,
        ip: actor.ip ?? null,
        providerEventId: providerEventId ?? null,
      },
      select: { id: true },
    });
  }

  private async sync(tx: Db, contact: MarketingContact): Promise<void> {
    await this.outbox.enqueue(tx, {
      type: 'marketing.sync',
      dedupeKey: `marketing.sync:${contact.id}:${contact.syncVersion}`,
      payload: { contactId: contact.id, version: contact.syncVersion },
    });
  }
}
