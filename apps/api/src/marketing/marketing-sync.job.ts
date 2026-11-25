import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MarketingStatus } from '../generated/prisma/client.js';
import { lockMarketingSync } from '../orders/locks.js';
import { OutboxService, type OutboxJobRow } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { marketingFields } from './marketing-fields.js';
import { MARKETING_PROVIDER, type MarketingProvider } from './marketing-provider.js';

export interface MarketingSyncPayload {
  contactId: string;
  version: number;
}

/** One sync transaction: a provider call (≤ 10 s) plus, at most, the wait for the run of the same contact before it. */
const SYNC_TX_TIMEOUT_MS = 30_000;

/**
 * The outbox job `marketing.sync` (spec §5.4, CLB-11): `MarketingService` enqueues it with every status change of a
 * contact, a link to an account, and a paid order (`{ contactId, version }`, dedupe key per contact and version). The
 * handler reads the contact **now**, so a job queued before a later change does the right thing: `subscribed` →
 * `upsertContact` with the fields of this moment, anything else (pending, unsubscribed) → `removeContact`. Then
 * `syncedVersion = max(syncedVersion, version)`. A job whose version is already covered by a later run is skipped:
 * that run read the contact after this job's change, and any change since then has its own, higher version.
 *
 * Runs of one contact never overlap (spec 9a.4): each run takes the contact's sync lock (`lockMarketingSync`) first and
 * holds it, in one transaction, across the read, the provider call and the `syncedVersion` update — so version N's
 * call ends before N+1 reads the contact, whatever process runs them. Then it checks that its outbox claim still holds
 * (`OutboxService.holdsClaim`): a run reclaimed after hanging stops there and calls nothing. The provider call inside
 * the transaction is accepted: consent writes never wait for this lock (they take the per-e-mail lock), and real
 * adapters (Phase 9f) must set request timeouts of at most 10 s, well inside `SYNC_TX_TIMEOUT_MS`.
 */
@Injectable()
export class MarketingSyncJob implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    @Inject(MARKETING_PROVIDER) private readonly provider: MarketingProvider,
  ) {}

  onModuleInit(): void {
    this.outbox.register<MarketingSyncPayload>('marketing.sync', (p, job) => this.run(p, job));
  }

  async run({ contactId, version }: MarketingSyncPayload, job: Pick<OutboxJobRow, 'id' | 'claimToken'>): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        await lockMarketingSync(tx, contactId);
        if (!(await this.outbox.holdsClaim(tx, job))) return;
        const contact = await tx.marketingContact.findUnique({ where: { id: contactId } });
        // Contacts are never deleted outside tests; nothing to sync.
        if (!contact || contact.syncedVersion >= version) return;
        if (contact.status === MarketingStatus.SUBSCRIBED)
          await this.provider.upsertContact(await marketingFields(tx, contact));
        else await this.provider.removeContact(contact.email);
        // Raw: recording a sync is not a change of the contact (`updated_at` stays).
        await tx.$executeRaw`
          UPDATE marketing_contacts SET synced_version = GREATEST(synced_version, ${version})
          WHERE id = ${contactId}::uuid`;
      },
      { timeout: SYNC_TX_TIMEOUT_MS },
    );
  }
}
