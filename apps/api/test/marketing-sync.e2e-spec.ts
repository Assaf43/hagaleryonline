import type { AddressInfo } from 'node:net';
import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { CartView, ShippingQuote } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { ConsentAction, MarketingStatus } from './../src/generated/prisma/client.js';
import { MARKETING_PROVIDER, type SyncedContact } from './../src/marketing/marketing-provider.js';
import { MarketingService } from './../src/marketing/marketing.service.js';
import { MOCK_MARKETING_SIGNATURE_HEADER, MockMarketingProvider } from './../src/marketing/mock-marketing.provider.js';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from './../src/notifications/notification-provider.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteMarketingContacts } from './test-marketing.js';
import { deleteOrders } from './test-orders.js';
import { uniqueIds } from './unique-ids.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@mksync.e2e.test';
const PASSWORD = 'correct horse 12';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;

// Phase 7 §5.4 (CLB-11, decision 95): only subscribed contacts reach the e-mail tool, through outbox `marketing.sync`
// jobs that read the contact when they run; the tool reports unsubscribes through a signed webhook.
describe('Marketing sync and webhook (e2e, CLB-11)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let marketing: MarketingService;
  let mock: MockMarketingProvider;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let lamp: number;

  const unique = uniqueIds(7);
  const newEmail = () => `user${unique()}${DOMAIN}`;
  const http = () => request(app.getHttpServer() as App);
  const runJobs = () => outbox.runDue(100);
  const synced = (email: string) => mock.list().find((c) => c.email === email);
  const contactOf = (email: string) =>
    prisma.marketingContact.findUnique({ where: { email }, include: { events: { orderBy: { id: 'asc' } } } });

  const webhook = (body: string, signature?: string) => {
    const req = http().post('/api/marketing/webhook').set('Content-Type', 'application/json');
    return (signature === undefined ? req : req.set(MOCK_MARKETING_SIGNATURE_HEADER, signature)).send(body);
  };
  const providerUnsubscribe = (email: string, id: string) => {
    const { body, headers } = mock.signedWebhook([{ id, type: 'unsubscribed', email }]);
    return webhook(body, headers[MOCK_MARKETING_SIGNATURE_HEADER]);
  };

  const pending = (email: string) =>
    prisma.$transaction((tx) =>
      marketing.requestConfirmation(tx, { email, source: 'newsletter', channel: 'email', actor: {} }),
    );
  /**
   * A subscribed newsletter contact (no account): the request, its confirmation e-mail (jobs run), then the link.
   * The sync job of the confirmation is left queued.
   */
  const subscribe = async (email: string) => {
    await pending(email);
    await runJobs();
    const text = emailSpy.mock.calls
      .map(([m]) => m)
      .filter((m) => m.to === email)
      .at(-1)!.text;
    const token = /\/newsletter\/confirm\?t=([\w-]+)/.exec(text)![1];
    expect(await marketing.confirm(token, {})).toEqual({ email });
  };
  const withdraw = (email: string) =>
    prisma.$transaction((tx) => marketing.withdraw(tx, { email, source: 'account', actor: {} }));

  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    const write = (path: string, body: object = {}) => agent.post(path).set('Origin', ORIGIN).send(body);
    return { agent, write };
  };
  const lastCode = (calls: { to: string; text: string }[], to: string) =>
    /(\d{6})/.exec(calls.filter((m) => m.to === to).at(-1)!.text)![1];

  /** A website sign-up with marketing consent: a subscribed member contact. */
  const signUp = async (email: string) => {
    const phone = `05${unique()}`;
    const b = browser();
    const details = { fullName: 'ZZ נועה כהן', phone, email, password: PASSWORD, marketingConsent: true };
    await b.write('/api/account/sign-up', details).expect(200, { verify: true });
    const smsCode = lastCode(
      smsSpy.mock.calls.map(([m]) => m),
      phone,
    );
    const first = await b
      .write('/api/account/otp/verify', { target: phone, code: smsCode, purpose: 'sign_up' })
      .expect(200);
    const emailCode = lastCode(
      emailSpy.mock.calls.map(([m]) => m),
      email,
    );
    const second = await b
      .write('/api/account/otp/verify', {
        target: email,
        code: emailCode,
        purpose: 'sign_up',
        signUpToken: first.body.signUpToken,
      })
      .expect(200);
    await b.write('/api/account/sign-up', { ...details, signUpToken: second.body.signUpToken }).expect(200);
    return { b, phone };
  };

  /** Checks out one lamp and pays it through the sandbox page (the signed payment webhook). */
  const buyAndPay = async (b: ReturnType<typeof browser>, email: string, phone: string) => {
    await b.write('/api/cart/items', { variantId: lamp, quantity: 1 }).expect(200);
    const view = (await b.agent.get('/api/cart').expect(200)).body as CartView;
    const quote = (
      await b.write('/api/shipping/quote', { localityId: LOCALITY, floor: 0, hasElevator: true }).expect(200)
    ).body as ShippingQuote;
    const expectedTotal =
      view.subtotal - (view.discount?.amount ?? 0) + quote.methods.find((m) => m.method === 'curbside')!.total;
    const res = await b.write('/api/checkout', {
      contact: { fullName: 'ZZ נועה כהן', phone, email },
      address: {
        localityId: LOCALITY,
        street: 'הרצל',
        houseNumber: '12',
        apartment: null,
        floor: 0,
        hasElevator: true,
        notes: null,
      },
      method: 'curbside',
      acceptTerms: true,
      marketingConsent: false,
      expectedTotal,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const tx = /\/pay\/sandbox\/([\w-]+)/.exec((res.body as { redirectUrl: string }).redirectUrl)![1];
    await http()
      .post(`/api/payments/sandbox/${tx}/complete`)
      .set('Origin', ORIGIN)
      .send({ outcome: 'success', installments: 1 })
      .expect(200);
  };

  const cleanData = async () => {
    await deleteOrders(prisma, { contact: { path: ['fullName'], string_starts_with: 'ZZ' } });
    await prisma.cart.deleteMany();
    await prisma.outboxJob.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.customer.deleteMany({ where: { fullName: { startsWith: 'ZZ' } } });
    await deleteMarketingContacts(prisma, { email: { endsWith: DOMAIN } });
    for (const c of mock.list()) await mock.removeContact(c.email);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    marketing = app.get(MarketingService);
    mock = app.get<MockMarketingProvider>(MARKETING_PROVIDER);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    // resetAdminData TRUNCATEs admin_users CASCADE (customers and orders go too): every fixture comes after it.
    await resetAdminData(prisma);
    await cleanData();
    await prisma.category.deleteMany({ where: { slug: 'zz-mksync' } });
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    const category = await prisma.category.create({
      data: {
        slug: 'zz-mksync',
        nameHe: 'בדיקת סנכרון',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const product = await prisma.product.create({
      data: {
        slug: 'zz-mksync-lamp',
        modelName: 'ZZMKSYNC',
        nameHe: 'מנורת סנכרון',
        categoryId: category.id,
        variants: {
          create: [
            {
              sku: 'ZZMKSYNC-1',
              price: 50_000,
              stock: 100,
              sortOrder: 0,
              widthCm: 40,
              depthCm: 40,
              heightCm: 150,
              leadTimeDays: 7,
            },
          ],
        },
      },
      include: { variants: true },
    });
    lamp = product.variants[0].id;
    await app.get(CacheStore).invalidate('catalog:');
  });

  afterEach(async () => {
    await cleanData();
  });

  afterAll(async () => {
    await cleanData();
    await resetAdminData(prisma);
    await prisma.category.deleteMany({ where: { slug: 'zz-mksync' } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  it('subscribe → run outbox → the contact is in the mock, version recorded', async () => {
    const email = newEmail();
    await subscribe(email);
    expect(synced(email)).toBeUndefined();
    await runJobs();
    expect(synced(email)).toEqual<SyncedContact>({
      email,
      firstName: null,
      tags: ['newsletter'],
      hasPurchased: false,
      lastPaidOrderAt: null,
      interestCategories: [],
    });
    const contact = await contactOf(email);
    expect(contact!.syncedVersion).toBe(contact!.syncVersion);
  });

  it('a pending contact never reaches the mock', async () => {
    const email = newEmail();
    expect(await pending(email)).toBe('sent');
    await runJobs();
    expect(synced(email)).toBeUndefined();
    expect((await contactOf(email))!.status).toBe(MarketingStatus.PENDING);
  });

  it('withdraw → removed from the mock', async () => {
    const email = newEmail();
    await subscribe(email);
    await runJobs();
    expect(synced(email)).toBeDefined();
    await withdraw(email);
    await runJobs();
    expect(synced(email)).toBeUndefined();
  });

  it('unsubscribe beats queued sync', async () => {
    const email = newEmail();
    await subscribe(email);
    // The subscribe job is still queued when the tool reports the unsubscribe.
    await providerUnsubscribe(email, `evt_${unique()}`).expect(204);
    await runJobs();
    expect(synced(email)).toBeUndefined();
    expect((await contactOf(email))!.status).toBe(MarketingStatus.UNSUBSCRIBED);
  });

  it('webhook: a bad or missing signature is 401 and changes nothing', async () => {
    const email = newEmail();
    await subscribe(email);
    const { body } = mock.signedWebhook([{ id: `evt_${unique()}`, type: 'unsubscribed', email }]);
    await webhook(body, 'f'.repeat(64)).expect(401);
    await webhook(body).expect(401);
    expect((await contactOf(email))!.status).toBe(MarketingStatus.SUBSCRIBED);
  });

  it('webhook: a duplicate event id records no second history row', async () => {
    const email = newEmail();
    await subscribe(email);
    const id = `evt_${unique()}`;
    await providerUnsubscribe(email, id).expect(204);
    await providerUnsubscribe(email, id).expect(204);
    const contact = await contactOf(email);
    expect(contact!.events.map((e) => e.action)).toEqual([
      ConsentAction.REQUESTED,
      ConsentAction.CONFIRMED,
      ConsentAction.PROVIDER_UNSUBSCRIBED,
    ]);
    expect(contact!.events[2].providerEventId).toBe(id);
  });

  it('a paid order syncs the member again: purchased, last paid time, top-level interest', async () => {
    const email = newEmail();
    const { b, phone } = await signUp(email);
    await runJobs();
    expect(synced(email)).toMatchObject({ tags: ['member'], firstName: 'ZZ', hasPurchased: false });
    await buyAndPay(b, email, phone);
    await runJobs();
    const fields = synced(email)!;
    expect(fields).toMatchObject({ tags: ['member'], hasPurchased: true, interestCategories: ['zz-mksync'] });
    expect(Date.parse(fields.lastPaidOrderAt!)).toBeGreaterThan(Date.now() - 60_000);
    const contact = await contactOf(email);
    expect(contact!.syncedVersion).toBe(contact!.syncVersion);
  });

  it('dev endpoints: list and unsubscribe through the webhook path, orders.manage only', async () => {
    const email = newEmail();
    await subscribe(email);
    await runJobs();
    await editor.get('/dev/marketing').expect(403);
    const list = (await owner.get('/dev/marketing').expect(200)).body as SyncedContact[];
    expect(list.map((c) => c.email)).toContain(email);
    await editor.post('/dev/marketing/unsubscribe', { email }).expect(403);
    await owner.post('/dev/marketing/unsubscribe', { email: 'not-an-email' }).expect(400);
    await owner.post('/dev/marketing/unsubscribe', { email }).expect(204);
    const contact = await contactOf(email);
    expect(contact!.status).toBe(MarketingStatus.UNSUBSCRIBED);
    expect(contact!.events.at(-1)).toMatchObject({ action: ConsentAction.PROVIDER_UNSUBSCRIBED });
    expect(contact!.events.at(-1)!.providerEventId).toMatch(/^mock_evt_/);
  });

  it('dev endpoints: 404 unless the marketing and both notification providers are mock', async () => {
    const real = Object.getOwnPropertyDescriptor(mock, 'code');
    Object.defineProperty(mock, 'code', { value: 'mailchimp', configurable: true });
    try {
      await owner.get('/dev/marketing').expect(404);
      await owner.post('/dev/marketing/unsubscribe', { email: newEmail() }).expect(404);
    } finally {
      if (real) Object.defineProperty(mock, 'code', real);
    }
    const sms = app.get<SmsProvider>(SMS_PROVIDER);
    const smsCode = Object.getOwnPropertyDescriptor(sms, 'code');
    Object.defineProperty(sms, 'code', { value: 'inforu', configurable: true });
    try {
      await owner.get('/dev/marketing').expect(404);
    } finally {
      if (smsCode) Object.defineProperty(sms, 'code', smsCode);
    }
    await owner.get('/dev/marketing').expect(200);
  });

  it('the API refuses to start without MARKETING_PROVIDER', async () => {
    const saved = process.env.MARKETING_PROVIDER;
    // Empty, not deleted: the env file would fill a missing variable back in.
    process.env.MARKETING_PROVIDER = '';
    try {
      await expect(Test.createTestingModule({ imports: [AppModule] }).compile()).rejects.toThrow(
        /MARKETING_PROVIDER is not set/,
      );
    } finally {
      process.env.MARKETING_PROVIDER = saved;
    }
  });
});
