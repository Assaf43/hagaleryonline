import type { ConfigService } from '@nestjs/config';
import { MarketingWebhookPayloadError, MarketingWebhookSignatureError } from './marketing-provider.js';
import { MOCK_MARKETING_SIGNATURE_HEADER, MockMarketingProvider } from './mock-marketing.provider.js';

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;
const SECRET = 'unit-marketing-secret';
const contact = (email: string) => ({
  email,
  firstName: null,
  tags: ['newsletter' as const],
  hasPurchased: false,
  lastPaidOrderAt: null,
  interestCategories: [],
});

describe('MockMarketingProvider', () => {
  it('refuses NODE_ENV=production', () => {
    expect(() => new MockMarketingProvider(config({ NODE_ENV: 'production', MARKETING_MOCK_SECRET: SECRET }))).toThrow(
      /production/,
    );
  });

  it('keeps the synced list in memory: upsert replaces, remove deletes, unknown remove is fine', async () => {
    const p = new MockMarketingProvider(config({ MARKETING_MOCK_SECRET: SECRET }));
    expect(p.code).toBe('mock');
    await p.upsertContact(contact('a@x.test'));
    await p.upsertContact({ ...contact('a@x.test'), hasPurchased: true });
    await p.upsertContact(contact('b@x.test'));
    await p.removeContact('b@x.test');
    await p.removeContact('nobody@x.test');
    expect(p.list()).toEqual([{ ...contact('a@x.test'), hasPurchased: true }]);
  });

  it('accepts its own signed webhook', () => {
    const p = new MockMarketingProvider(config({ MARKETING_MOCK_SECRET: SECRET }));
    const { body, headers } = p.signedWebhook([{ id: 'evt_1', type: 'unsubscribed', email: 'a@x.test' }]);
    expect(p.verifyWebhook(Buffer.from(body), headers)).toEqual([
      { id: 'evt_1', type: 'unsubscribed', email: 'a@x.test' },
    ]);
  });

  it('mock rejects a bad signature', () => {
    const p = new MockMarketingProvider(config({ MARKETING_MOCK_SECRET: SECRET }));
    const other = new MockMarketingProvider(config({ MARKETING_MOCK_SECRET: 'another-secret' }));
    const { body, headers } = other.signedWebhook([{ id: 'evt_1', type: 'unsubscribed', email: 'a@x.test' }]);
    expect(() => p.verifyWebhook(Buffer.from(body), headers)).toThrow(MarketingWebhookSignatureError);
    expect(() => p.verifyWebhook(Buffer.from(body), {})).toThrow(MarketingWebhookSignatureError);
    const own = p.signedWebhook([{ id: 'evt_1', type: 'unsubscribed', email: 'a@x.test' }]);
    // One byte changed after signing.
    expect(() => p.verifyWebhook(Buffer.from(own.body.replace('a@x', 'b@x')), own.headers)).toThrow(
      MarketingWebhookSignatureError,
    );
  });

  it('a signed body that makes no sense is a payload error', () => {
    const p = new MockMarketingProvider(config({ MARKETING_MOCK_SECRET: SECRET }));
    for (const body of ['not json', '{}', '{"events":[{"id":"","type":"unsubscribed","email":"a@x.test"}]}'])
      expect(() => p.verifyWebhook(Buffer.from(body), { [MOCK_MARKETING_SIGNATURE_HEADER]: p.sign(body) })).toThrow(
        MarketingWebhookPayloadError,
      );
  });
});
