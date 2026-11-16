import { hashToken } from '../auth/crypto.js';
import { ConsentAction, MarketingConsentSource, MarketingStatus } from '../generated/prisma/client.js';
import type { OutboxService } from '../outbox/outbox.service.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import { CONFIRM_TTL_MS, UnsubscribeTokens } from './marketing-tokens.js';
import { MarketingService } from './marketing.service.js';

const DAY_MS = 24 * 60 * 60_000;

type Row = Record<string, unknown>;

/** True when `row` matches a Prisma-like `where` of equality, `{ not }` and `{ gte }` conditions. */
function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      const c = cond as { not?: unknown; gte?: Date };
      if ('not' in c) return row[key] !== c.not;
      if (c.gte) return (row[key] as Date).getTime() >= c.gte.getTime();
    }
    return row[key] === cond;
  });
}

/** The few Prisma calls MarketingService makes, over arrays (one transaction client is the whole fake). */
function fakeDb() {
  const contacts: Row[] = [];
  const events: Row[] = [];
  const customers: Row[] = [];
  let ids = 0;
  const apply = (row: Row, data: Row) => {
    for (const [key, value] of Object.entries(data)) {
      if (value && typeof value === 'object' && 'increment' in value)
        row[key] = (row[key] as number) + (value as { increment: number }).increment;
      else row[key] = value;
    }
    return row;
  };
  const db = {
    $executeRaw: vi.fn().mockResolvedValue(1),
    $transaction: (fn: (tx: unknown) => Promise<unknown>) => fn(db),
    marketingContact: {
      findUnique: ({ where }: { where: Row }) => Promise.resolve(contacts.find((c) => matches(c, where)) ?? null),
      create: ({ data }: { data: Row }) => {
        const row = apply(
          {
            id: `c-${++ids}`,
            customerId: null,
            consentAt: null,
            unsubscribedAt: null,
            confirmTokenHash: null,
            confirmExpiresAt: null,
            syncVersion: 0,
            syncedVersion: 0,
          },
          data,
        );
        contacts.push(row);
        return Promise.resolve(row);
      },
      update: ({ where, data }: { where: Row; data: Row }) =>
        Promise.resolve(
          apply(
            contacts.find((c) => matches(c, where))!,
            data,
          ),
        ),
      updateMany: ({ where, data }: { where: Row; data: Row }) => {
        const hit = contacts.filter((c) => matches(c, where));
        hit.forEach((c) => apply(c, data));
        return Promise.resolve({ count: hit.length });
      },
    },
    marketingConsentEvent: {
      create: ({ data }: { data: Row }) => {
        const row = { id: BigInt(events.length + 1), at: new Date(), ...data };
        events.push(row);
        return Promise.resolve(row);
      },
      count: ({ where }: { where: Row }) => Promise.resolve(events.filter((e) => matches(e, where)).length),
      findUnique: ({ where }: { where: Row }) => Promise.resolve(events.find((e) => matches(e, where)) ?? null),
    },
    customer: {
      findFirst: ({ where }: { where: Row }) => Promise.resolve(customers.find((c) => matches(c, where)) ?? null),
    },
  };
  return { db, contacts, events, customers };
}

function setup() {
  const fake = fakeDb();
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const outbox = { enqueue } as unknown as OutboxService;
  const service = new MarketingService(
    fake.db as unknown as PrismaService,
    outbox,
    new UnsubscribeTokens('unit-test-secret'),
  );
  const tx = fake.db as never;
  const jobs = (type: string) => enqueue.mock.calls.filter(([, job]) => (job as { type: string }).type === type);
  return { ...fake, service, tx, enqueue, jobs };
}

const contact = (data: Row): Row => ({
  id: 'c-seed',
  email: 'dana@example.test',
  customerId: null,
  status: MarketingStatus.PENDING,
  source: MarketingConsentSource.CHECKOUT,
  consentAt: null,
  unsubscribedAt: null,
  confirmTokenHash: null,
  confirmExpiresAt: null,
  unsubscribeTokenHash: 'seed-hash',
  syncVersion: 1,
  syncedVersion: 0,
  ...data,
});

describe('MarketingService (decision 95, CLB-02)', () => {
  it('subscribed contact gets no second request', async () => {
    const t = setup();
    t.contacts.push(contact({ status: MarketingStatus.SUBSCRIBED, consentAt: new Date() }));
    const result = await t.service.requestConfirmation(t.tx, {
      email: ' Dana@Example.test ',
      source: 'checkout',
      channel: 'email',
      actor: {},
    });
    expect(result).toBe('already_subscribed');
    expect(t.events).toEqual([]);
    expect(t.enqueue).not.toHaveBeenCalled();
    expect(t.contacts[0].status).toBe(MarketingStatus.SUBSCRIBED);
  });

  it('fourth request in 24h is throttled', async () => {
    const t = setup();
    const ask = () =>
      t.service.requestConfirmation(t.tx, {
        email: 'dana@example.test',
        source: 'checkout',
        channel: 'email',
        actor: {},
      });
    expect([await ask(), await ask(), await ask()]).toEqual(['sent', 'sent', 'sent']);
    expect(await ask()).toBe('throttled');
    expect(t.events.filter((e) => e.action === ConsentAction.REQUESTED)).toHaveLength(3);
    expect(t.jobs('email.newsletter_confirm')).toHaveLength(3);
    // One status change (none → pending): one sync job.
    expect(t.jobs('marketing.sync')).toHaveLength(1);
    expect(t.contacts).toHaveLength(1);
    expect(t.contacts[0]).toMatchObject({ status: MarketingStatus.PENDING, source: MarketingConsentSource.CHECKOUT });
    // A request older than 24 hours no longer counts.
    t.events[0].at = new Date(Date.now() - DAY_MS - 1000);
    expect(await ask()).toBe('sent');
  });

  it('a store request by SMS sends the store_consent job to the phone, never the raw token', async () => {
    const t = setup();
    const result = await t.service.requestConfirmation(t.tx, {
      email: 'dana@example.test',
      source: 'store',
      channel: 'sms',
      phone: '0501234567',
      actor: { sellerId: 7 },
    });
    expect(result).toBe('sent');
    const [[, job]] = t.jobs('sms.store_consent');
    expect(job).toMatchObject({ payload: { contactId: t.contacts[0].id, phone: '0501234567' } });
    expect(t.events[0]).toMatchObject({ action: ConsentAction.REQUESTED, source: 'STORE', actorSellerId: 7 });
    expect(t.contacts[0].confirmTokenHash).toBeNull();
  });

  it('confirm after 7 days returns null', async () => {
    const t = setup();
    const sentAt = Date.now() - CONFIRM_TTL_MS - 1000;
    t.contacts.push(
      contact({ confirmTokenHash: hashToken('old-token'), confirmExpiresAt: new Date(sentAt + CONFIRM_TTL_MS) }),
    );
    expect(await t.service.confirm('old-token', {})).toBeNull();
    expect(await t.service.confirm('unknown', {})).toBeNull();
    expect(t.contacts[0].status).toBe(MarketingStatus.PENDING);
    expect(t.events).toEqual([]);

    // Inside the 7 days: subscribed, token cleared, one `confirmed` event and a sync job.
    t.contacts[0].confirmTokenHash = hashToken('new-token');
    t.contacts[0].confirmExpiresAt = new Date(Date.now() + DAY_MS);
    expect(await t.service.confirm('new-token', { ip: '10.0.0.1' })).toEqual({ email: 'dana@example.test' });
    expect(t.contacts[0]).toMatchObject({
      status: MarketingStatus.SUBSCRIBED,
      confirmTokenHash: null,
      confirmExpiresAt: null,
      syncVersion: 2,
    });
    expect(t.contacts[0].consentAt).toBeInstanceOf(Date);
    expect(t.events).toEqual([
      expect.objectContaining({
        action: ConsentAction.CONFIRMED,
        source: MarketingConsentSource.CHECKOUT,
        ip: '10.0.0.1',
      }),
    ]);
    expect(t.jobs('marketing.sync')).toEqual([
      [
        t.tx,
        { type: 'marketing.sync', dedupeKey: 'marketing.sync:c-seed:2', payload: { contactId: 'c-seed', version: 2 } },
      ],
    ]);
    // The link works once.
    expect(await t.service.confirm('new-token', {})).toBeNull();
  });

  it('release unlinks and unsubscribes', async () => {
    const t = setup();
    t.contacts.push(contact({ status: MarketingStatus.SUBSCRIBED, customerId: 'cust-1', consentAt: new Date() }));
    await t.service.releaseEmail(t.tx, 'dana@example.test', 'changed');
    expect(t.contacts[0]).toMatchObject({ status: MarketingStatus.UNSUBSCRIBED, customerId: null, syncVersion: 2 });
    expect(t.contacts[0].unsubscribedAt).toBeInstanceOf(Date);
    expect(t.events).toEqual([expect.objectContaining({ action: ConsentAction.RELEASED, contactId: 'c-seed' })]);
    expect(t.jobs('marketing.sync')).toHaveLength(1);
    // An unknown e-mail: nothing.
    await t.service.releaseEmail(t.tx, 'nobody@example.test', 'released');
    expect(t.events).toHaveLength(1);
  });

  it('subscribeVerified: subscribed now with one confirmed event, a repeat changes nothing', async () => {
    const t = setup();
    const input = {
      email: 'dana@example.test',
      customerId: 'cust-1',
      source: 'signup',
      actor: { customerId: 'cust-1' },
    } as const;
    await t.service.subscribeVerified(t.tx, input);
    await t.service.subscribeVerified(t.tx, input);
    expect(t.contacts).toEqual([
      expect.objectContaining({
        status: MarketingStatus.SUBSCRIBED,
        source: MarketingConsentSource.SIGNUP,
        customerId: 'cust-1',
        syncVersion: 1,
      }),
    ]);
    expect(t.contacts[0].unsubscribeTokenHash).toBe(
      new UnsubscribeTokens('unit-test-secret').hash(t.contacts[0].id as string),
    );
    expect(t.events).toEqual([expect.objectContaining({ action: ConsentAction.CONFIRMED, actorCustomerId: 'cust-1' })]);
    expect(t.jobs('marketing.sync')).toHaveLength(1);
  });

  it('withdraw and unsubscribe by token record one event each; the provider event id is used once', async () => {
    const t = setup();
    const tokens = new UnsubscribeTokens('unit-test-secret');
    t.contacts.push(contact({ status: MarketingStatus.SUBSCRIBED, unsubscribeTokenHash: tokens.hash('c-seed') }));
    await t.service.unsubscribeByToken(tokens.token('c-seed'), { ip: '10.0.0.2' });
    expect(t.contacts[0].status).toBe(MarketingStatus.UNSUBSCRIBED);
    await t.service.withdraw(t.tx, { email: 'dana@example.test', source: 'account', actor: {} });
    expect(t.events.map((e) => e.action)).toEqual([ConsentAction.WITHDRAWN]);

    t.contacts[0].status = MarketingStatus.SUBSCRIBED;
    await t.service.providerUnsubscribed('dana@example.test', 'evt-1');
    await t.service.providerUnsubscribed('dana@example.test', 'evt-1');
    expect(t.contacts[0].status).toBe(MarketingStatus.UNSUBSCRIBED);
    expect(t.events.filter((e) => e.action === ConsentAction.PROVIDER_UNSUBSCRIBED)).toEqual([
      expect.objectContaining({ providerEventId: 'evt-1' }),
    ]);
  });
});
