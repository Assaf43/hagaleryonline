import type { ConfigService } from '@nestjs/config';
import { selectPaymentProvider, WebhookPayloadError, WebhookSignatureError } from './payment-provider.js';
import { SandboxPaymentProvider } from './sandbox-payment.provider.js';
import { sign } from './webhook-signature.js';

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;
const SECRET = 'unit-secret';

describe('SandboxPaymentProvider (spec §5.3, CHK-10)', () => {
  const sandbox = () =>
    new SandboxPaymentProvider(config({ PAYMENT_SANDBOX_SECRET: SECRET, SITE_URL: 'https://x.test/' }));

  it('refuses to load when NODE_ENV=production', () => {
    expect(
      () => new SandboxPaymentProvider(config({ NODE_ENV: 'production', PAYMENT_SANDBOX_SECRET: SECRET })),
    ).toThrow(/cannot run in production/);
    expect(
      () =>
        new SandboxPaymentProvider(
          config({ NODE_ENV: 'production', PAYMENT_SANDBOX_ALLOW_REMOTE: 'true', PAYMENT_SANDBOX_SECRET: SECRET }),
        ),
    ).toThrow(/cannot run in production/);
  });

  it('refuses a public site address unless a test environment allows it explicitly (NODE_ENV may be missing)', () => {
    for (const site of ['https://hagaleryonline.co.il', 'https://www.example.com/', 'http://10.0.0.5:4200']) {
      expect(() => new SandboxPaymentProvider(config({ SITE_URL: site, PAYMENT_SANDBOX_SECRET: SECRET }))).toThrow(
        /PAYMENT_SANDBOX_ALLOW_REMOTE/,
      );
      expect(
        () =>
          new SandboxPaymentProvider(
            config({ SITE_URL: site, PAYMENT_SANDBOX_ALLOW_REMOTE: 'true', PAYMENT_SANDBOX_SECRET: SECRET }),
          ),
      ).not.toThrow();
    }
    // The storefront address counts too when there is no SITE_URL.
    expect(
      () =>
        new SandboxPaymentProvider(
          config({ STOREFRONT_URL: 'https://shop.example.com', PAYMENT_SANDBOX_SECRET: SECRET }),
        ),
    ).toThrow(/PAYMENT_SANDBOX_ALLOW_REMOTE/);
  });

  it('runs on development addresses', () => {
    for (const site of [
      undefined,
      'http://localhost:4200',
      'http://127.0.0.1:4200',
      'http://[::1]:4200',
      'http://shop.localhost',
      'https://x.test/',
    ])
      expect(
        () =>
          new SandboxPaymentProvider(config({ ...(site ? { SITE_URL: site } : {}), PAYMENT_SANDBOX_SECRET: SECRET })),
      ).not.toThrow();
  });

  it('opens a storefront payment page with a random transaction id', async () => {
    const order = {
      orderId: 'o',
      orderNumber: 100_001,
      amount: 5,
      customer: { fullName: 'a', phone: 'b', email: 'c' },
    };
    const a = await sandbox().createPaymentPage(order);
    const b = await sandbox().createPaymentPage(order);
    expect(a.transactionId).toMatch(/^sbx_[0-9a-f]{32}$/);
    expect(a.transactionId).not.toBe(b.transactionId);
    expect(a.redirectUrl).toBe(`https://x.test/pay/sandbox/${a.transactionId}`);
  });

  it('verifies its own signed webhook and reads the result', async () => {
    const provider = sandbox();
    const { body, headers } = provider.signedWebhook({
      transactionId: 'sbx_1',
      status: 'succeeded',
      amount: 1000,
      installments: 6,
    });
    await expect(provider.verifyWebhook(headers, Buffer.from(body))).resolves.toEqual({
      transactionId: 'sbx_1',
      status: 'succeeded',
      amount: 1000,
      installments: 6,
      rawStatus: 'succeeded',
    });
  });

  it('rejects a wrong signature before reading the body, and a signed body that makes no sense', async () => {
    const provider = sandbox();
    const body = '{"transactionId":"sbx_1","status":"succeeded","amount":1000}';
    await expect(
      provider.verifyWebhook({ 'x-sandbox-signature': sign(body, 'other') }, Buffer.from(body)),
    ).rejects.toBeInstanceOf(WebhookSignatureError);
    await expect(provider.verifyWebhook({}, Buffer.from(body))).rejects.toBeInstanceOf(WebhookSignatureError);
    for (const bad of [
      'not json',
      '[]',
      '{"transactionId":"x","status":"paid","amount":1}',
      '{"transactionId":"x","status":"failed","amount":-1}',
    ])
      await expect(
        provider.verifyWebhook({ 'x-sandbox-signature': sign(bad, SECRET) }, Buffer.from(bad)),
      ).rejects.toBeInstanceOf(WebhookPayloadError);
  });
});

describe('selectPaymentProvider', () => {
  it('builds only the selected adapter and fails on an unknown code', () => {
    const built: string[] = [];
    const factories = {
      sandbox: () => (built.push('sandbox'), { code: 'sandbox' }) as never,
      other: () => (built.push('other'), { code: 'other' }) as never,
    };
    expect(selectPaymentProvider('sandbox', factories)).toEqual({ code: 'sandbox' });
    expect(selectPaymentProvider(' other ', factories)).toEqual({ code: 'other' });
    expect(built).toEqual(['sandbox', 'other']);
    expect(() => selectPaymentProvider('toString', factories)).toThrow(/Unknown PAYMENT_PROVIDER "toString"/);
  });

  it('has no default: a missing PAYMENT_PROVIDER stops the API instead of falling back to the sandbox', () => {
    const factories = { sandbox: () => ({ code: 'sandbox' }) as never };
    for (const code of [undefined, '', '  '])
      expect(() => selectPaymentProvider(code, factories)).toThrow(/PAYMENT_PROVIDER is not set/);
  });
});
