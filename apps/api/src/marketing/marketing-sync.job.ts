import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MarketingStatus } from '../generated/prisma/client.js';
import { OutboxService } from '../outbox/outbox.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { marketingFields } from './marketing-fields.js';
import { MARKETING_PROVIDER, type MarketingProvider } from './marketing-provider.js';

export interface MarketingSyncPayload {
  contactId: string;
  version: number;
}

/**
 * The outbox job `marketing.sync` (spec §5.4, CLB-11): `MarketingService` enqueues it with every status change of a
 * contact, a link to an account, and a paid order (`{ contactId, version }`, dedupe key per contact and version). The
 * handler reads the contact **now**, so a job queued before a later change does the right thing: `subscribed` →
 * `upsertContact` with the fields of this moment, anything else (pending, unsubscribed) → `removeContact`. Then
 * `syncedVersion = max(syncedVersion, version)`. A job whose version is already covered by a later run is skipped:
 * that run read the contact after this job's change, and any change since then has its own, higher version.
 *
 * One API process only: the outbox runs jobs one after another, so version N's upsert ends before N+1's remove starts.
 * With several processes (or a job reclaimed after 10 minutes, see `OutboxService`) N and N+1 could run at once and
 * the older read could land last at the tool — add the outbox claim token and order the runs per contact first.
 */
@Injectable()
export class MarketingSyncJob implements OnModuleInit {
  constructor(
    private readonly outbox: OutboxService,
    private readonly prisma: PrismaService,
    @Inject(MARKETING_PROVIDER) private readonly provider: MarketingProvider,
  ) {}

  onModuleInit(): void {
    this.outbox.register<MarketingSyncPayload>('marketing.sync', (p) => this.run(p));
  }

  async run({ contactId, version }: MarketingSyncPayload): Promise<void> {
    const contact = await this.prisma.marketingContact.findUnique({ where: { id: contactId } });
    // Contacts are never deleted outside tests; nothing to sync.
    if (!contact || contact.syncedVersion >= version) return;
    if (contact.status === MarketingStatus.SUBSCRIBED)
      await this.provider.upsertContact(await marketingFields(this.prisma, contact));
    else await this.provider.removeContact(contact.email);
    // Raw: recording a sync is not a change of the contact (`updated_at` stays).
    await this.prisma.$executeRaw`
      UPDATE marketing_contacts SET synced_version = GREATEST(synced_version, ${version})
      WHERE id = ${contactId}::uuid`;
  }
}
