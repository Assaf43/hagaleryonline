import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  CONSENT_TEXT_VERSION,
  type AccountConsent,
  type CartView,
  type CustomerMe,
  type ShippingQuote,
  type StoreCartView,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { hashToken } from './../src/auth/crypto.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  ConsentAction,
  CustomerOrigin,
  MarketingConsentSource,
  MarketingStatus,
} from './../src/generated/prisma/client.js';
import { MarketingService } from './../src/marketing/marketing.service.js';
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
import { listenSafe } from './listen-safe.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@mkt.e2e.test';
const PASSWORD = 'correct horse 12';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;

// Phase 7 §2.6–2.7, §4.4, §5.3 (CLB-02, CLB-08, ACC-05, decisions 95–96): every consent change goes through the
// marketing contact of the e-mail and its append-only history. Messages are read from the mock providers' calls.
describe('Marketing consent (e2e, CLB-02, CLB-08, ACC-05)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let marketing: MarketingService;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  let seller: AdminBrowser;
  let lamp: number;
  /** Raw tokens seen in messages: none of them, nor any stored hash, may appear in audit_log. */
  const seenTokens: string[] = [];

  const unique = uniqueIds(7);
  const newPhone = () => `05${unique()}`;
  const newEmail = () => `user${unique()}${DOMAIN}`;

  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    const write = (method: 'post' | 'put', path: string, body: object = {}) =>
      agent[method](path).set('Origin', ORIGIN).send(body);
    return { agent, write, post: (path: string, body: object = {}) => write('post', `/api/account/${path}`, body) };
  };
  type Browser = ReturnType<typeof browser>;
  const lastCode = (calls: { to: string; text: string }[], to: string) =>
    /(\d{6})/.exec(calls.filter((m) => m.to === to).at(-1)!.text)![1];
  const smsCode = (to: string) =>
    lastCode(
      smsSpy.mock.calls.map(([m]) => m),
      to,
    );
  const emailCode = (to: string) =>
    lastCode(
      emailSpy.mock.calls.map(([m]) => m),
      to,
    );

  const contactOf = (email: string) =>
    prisma.marketingContact.findUnique({ where: { email }, include: { events: { orderBy: { id: 'asc' } } } });
  const runJobs = () => outbox.runDue(100);
  const linkIn = (text: string, path: 'confirm' | 'unsubscribe') => {
    const token = new RegExp(`/newsletter/${path}\\?t=([\\w-]+)`).exec(text)?.[1];
    if (token) seenTokens.push(token);
    return token;
  };

  /** A website sign-up with both codes; returns the signed-in browser. */
  const signUp = async (opts: { email?: string; phone?: string; marketingConsent?: boolean } = {}) => {
    const phone = opts.phone ?? newPhone();
    const email = opts.email ?? newEmail();
    const b = browser();
    const details = {
      fullName: 'ZZ דנה לוי',
      phone,
      email,
      password: PASSWORD,
      marketingConsent: !!opts.marketingConsent,
    };
    await b.post('sign-up', details).expect(200, { verify: true });
    const first = await b.post('otp/verify', { target: phone, code: smsCode(phone), purpose: 'sign_up' }).expect(200);
    const second = await b
      .post('otp/verify', {
        target: email,
        code: emailCode(email),
        purpose: 'sign_up',
        signUpToken: first.body.signUpToken,
      })
      .expect(200);
    const res = await b.post('sign-up', { ...details, signUpToken: second.body.signUpToken }).expect(200);
    return { b, phone, email, me: (res.body as { customer: CustomerMe }).customer };
  };

  const checkoutBody = (email: string, marketingConsent: boolean) => ({
    contact: { fullName: 'ZZ דנה כהן', phone: '050-1234567', email },
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
    marketingConsent,
  });
  const checkout = async (b: Browser, email: string, marketingConsent: boolean) => {
    await b.write('post', '/api/cart/items', { variantId: lamp, quantity: 1 }).expect(200);
    const view = (await b.agent.get('/api/cart').expect(200)).body as CartView;
    const quote = (
      await b.write('post', '/api/shipping/quote', { localityId: LOCALITY, floor: 0, hasElevator: true }).expect(200)
    ).body as ShippingQuote;
    const expectedTotal =
      view.subtotal - (view.discount?.amount ?? 0) + quote.methods.find((m) => m.method === 'curbside')!.total;
    const res = await b.write('post', '/api/checkout', { ...checkoutBody(email, marketingConsent), expectedTotal });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
  };

  const cleanData = async () => {
    await deleteOrders(prisma, { contact: { path: ['fullName'], string_starts_with: 'ZZ' } });
    await prisma.cart.deleteMany();
    await prisma.outboxJob.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.customer.deleteMany({ where: { fullName: { startsWith: 'ZZ' } } });
    await deleteMarketingContacts(prisma, { email: { endsWith: DOMAIN } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    process.env.API_INTERNAL_URL = await listenSafe(app);
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    marketing = app.get(MarketingService);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    // resetAdminData TRUNCATEs admin_users CASCADE (customers and contacts go too): every fixture comes after it.
    await resetAdminData(prisma);
    await cleanData();
    await prisma.category.deleteMany({ where: { slug: 'zz-mkt' } });
    seller = (await signInOwnerAnd(app, 'store_seller')).other;
    const category = await prisma.category.create({
      data: {
        slug: 'zz-mkt',
        nameHe: 'בדיקת דיוור',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const product = await prisma.product.create({
      data: {
        slug: 'zz-mkt-lamp',
        modelName: 'ZZMKT',
        nameHe: 'מנורת דיוור',
        categoryId: category.id,
        variants: {
          create: [
            {
              sku: 'ZZMKT-1',
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
    // No raw token from any message, nor any stored token hash, ever reaches the audit log.
    const audit = JSON.stringify(await prisma.auditLog.findMany());
    for (const token of seenTokens) {
      expect(audit).not.toContain(token);
      expect(audit).not.toContain(hashToken(token));
    }
    await cleanData();
    await resetAdminData(prisma);
    await prisma.category.deleteMany({ where: { slug: 'zz-mkt' } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  it('sign-up with consent: subscribed at once, source signup, one confirmed event, linked to the account', async () => {
    const { b, email, me } = await signUp({ marketingConsent: true });
    expect(me).toMatchObject({ marketingConsent: true });
    const contact = await contactOf(email);
    expect(contact).toMatchObject({
      status: MarketingStatus.SUBSCRIBED,
      source: MarketingConsentSource.SIGNUP,
      customerId: me.id,
      confirmTokenHash: null,
    });
    expect(contact!.consentAt).toBeInstanceOf(Date);
    expect(contact!.events).toEqual([
      expect.objectContaining({
        action: ConsentAction.CONFIRMED,
        source: MarketingConsentSource.SIGNUP,
        textVersion: '2026-11-16',
        actorCustomerId: me.id,
      }),
    ]);
    const res = await b.agent.get('/api/account/consent').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body as AccountConsent).toEqual({
      status: 'subscribed',
      source: 'signup',
      consentAt: contact!.consentAt!.toISOString(),
      emailVerified: true,
    });
    expect(await prisma.outboxJob.count({ where: { dedupeKey: `marketing.sync:${contact!.id}:1` } })).toBe(1);

    // Without consent: no contact at all.
    const other = await signUp();
    expect(await contactOf(other.email)).toBeNull();
    expect((await other.b.agent.get('/api/account/consent').expect(200)).body).toEqual({
      status: null,
      source: null,
      consentAt: null,
      emailVerified: true,
    });
  });

  it('guest checkout with the box: pending, one newsletter_confirm e-mail with both links, confirm → subscribed', async () => {
    const email = newEmail();
    await checkout(browser(), email, true);
    const order = await prisma.order.findFirstOrThrow({ where: { contact: { path: ['email'], equals: email } } });
    expect(order).toMatchObject({ marketingConsent: true, customerId: null });
    let contact = await contactOf(email);
    expect(contact).toMatchObject({
      status: MarketingStatus.PENDING,
      source: MarketingConsentSource.CHECKOUT,
      customerId: null,
    });
    expect(contact!.events.map((e) => e.action)).toEqual([ConsentAction.REQUESTED]);

    emailSpy.mockClear();
    await runJobs();
    expect(await prisma.notificationLog.count({ where: { template: 'newsletter_confirm' } })).toBeGreaterThanOrEqual(1);
    const sent = emailSpy.mock.calls.filter(([m]) => m.to === email);
    expect(sent).toHaveLength(1);
    const [message] = sent[0];
    const confirmToken = linkIn(message.text, 'confirm')!;
    const unsubscribeToken = linkIn(message.text, 'unsubscribe')!;
    expect(confirmToken).toBeDefined();
    expect(unsubscribeToken).toBeDefined();
    expect(message.html).toContain(`/newsletter/confirm?t=${confirmToken}`);
    expect(message.html).toContain(`/newsletter/unsubscribe?t=${unsubscribeToken}`);
    // Only hashes are stored.
    contact = await contactOf(email);
    expect(contact!.confirmTokenHash).toBe(hashToken(confirmToken));
    expect(contact!.unsubscribeTokenHash).toBe(hashToken(unsubscribeToken));
    expect(JSON.stringify(await prisma.outboxJob.findMany())).not.toContain(confirmToken);

    expect(await marketing.confirm(confirmToken, { ip: '127.0.0.1' })).toEqual({ email });
    contact = await contactOf(email);
    expect(contact).toMatchObject({
      status: MarketingStatus.SUBSCRIBED,
      source: MarketingConsentSource.CHECKOUT,
      confirmTokenHash: null,
    });
    expect(contact!.events.map((e) => e.action)).toEqual([ConsentAction.REQUESTED, ConsentAction.CONFIRMED]);
    expect(await marketing.confirm(confirmToken, {})).toBeNull();

    // The confirmation e-mail's unsubscribe link works after the confirmation too.
    await marketing.unsubscribeByToken(unsubscribeToken, {});
    contact = await contactOf(email);
    expect(contact!.status).toBe(MarketingStatus.UNSUBSCRIBED);
    expect(contact!.events.at(-1)).toMatchObject({ action: ConsentAction.WITHDRAWN });

    // Without the box: nothing.
    const plain = newEmail();
    await checkout(browser(), plain, false);
    expect(await contactOf(plain)).toBeNull();
  });

  it('signed-in checkout with the verified account e-mail subscribes at once; another contact e-mail gets a link', async () => {
    const { b, email, me } = await signUp();
    await checkout(b, email, true);
    expect(await contactOf(email)).toMatchObject({
      status: MarketingStatus.SUBSCRIBED,
      source: MarketingConsentSource.CHECKOUT,
      customerId: me.id,
    });
    const other = newEmail();
    await checkout(b, other, true);
    expect(await contactOf(other)).toMatchObject({ status: MarketingStatus.PENDING, customerId: null });
  });

  it('store order with the box: pending + store_consent SMS, confirm → subscribed with source store', async () => {
    const phone = newPhone();
    const email = newEmail();
    await seller.post('/store-cart').expect(201);
    await seller.post('/store-cart/items', { variantId: lamp, quantity: 1 }).expect(201);
    const newCustomer = { fullName: 'ZZ רון כהן', email };
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms', newCustomer }).expect(204);
    const verified = await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone), newCustomer })
      .expect(200);
    expect((verified.body as StoreCartView).customer).toMatchObject({ email, marketingStatus: null });
    const body = {
      address: checkoutBody(email, true).address,
      method: 'curbside',
      acceptTerms: true,
      marketingConsent: true,
    };
    const probe = await seller.post('/store-orders', { ...body, expectedTotal: 0 }).expect(409);
    const created = await seller
      .post('/store-orders', { ...body, expectedTotal: probe.body.total as number })
      .expect(201);
    // The answer says the SMS was queued, so the seller screen claims it only then.
    expect(created.body).toMatchObject({ consentSmsSent: true });
    let contact = await contactOf(email);
    expect(contact).toMatchObject({
      status: MarketingStatus.PENDING,
      source: MarketingConsentSource.STORE,
      customerId: null,
    });
    // The seller ticked the box; the customer saw no text yet (the confirmed event carries it).
    expect(contact!.events).toEqual([
      expect.objectContaining({
        action: ConsentAction.REQUESTED,
        actorSellerId: expect.any(Number),
        textVersion: null,
      }),
    ]);

    smsSpy.mockClear();
    await runJobs();
    const sms = smsSpy.mock.calls.filter(([m]) => m.to === phone);
    expect(sms).toHaveLength(1);
    expect(await prisma.notificationLog.count({ where: { template: 'store_consent' } })).toBeGreaterThanOrEqual(1);
    const token = linkIn(sms[0][0].text, 'confirm')!;
    expect(token).toBeDefined();
    expect(await marketing.confirm(token, {})).toEqual({ email });
    contact = await contactOf(email);
    expect(contact).toMatchObject({ status: MarketingStatus.SUBSCRIBED, source: MarketingConsentSource.STORE });
    expect(contact!.events.at(-1)).toMatchObject({
      action: ConsentAction.CONFIRMED,
      textVersion: CONSENT_TEXT_VERSION,
    });

    // A second store order with the box: already subscribed, no event and no SMS.
    await seller.post('/store-cart').expect(201);
    await seller.post('/store-cart/items', { variantId: lamp, quantity: 1 }).expect(201);
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms' }).expect(204);
    const again = await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone) })
      .expect(200);
    expect((again.body as StoreCartView).customer).toMatchObject({ marketingStatus: 'subscribed' });
    const probe2 = await seller.post('/store-orders', { ...body, expectedTotal: 0 }).expect(409);
    const second = await seller
      .post('/store-orders', { ...body, expectedTotal: probe2.body.total as number })
      .expect(201);
    expect(second.body).toMatchObject({ consentSmsSent: false });
    expect((await contactOf(email))!.events).toHaveLength(2);
    expect(await prisma.outboxJob.count({ where: { type: 'sms.store_consent', state: 'PENDING' } })).toBe(0);
  });

  it('account: consent on, the same again changes nothing, withdraw → unsubscribed with a withdrawn event', async () => {
    const { b, email, me } = await signUp();
    await b.write('put', '/api/account/consent', { marketingConsent: 'yes' }).expect(400);
    const on = await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(200);
    expect(on.headers['cache-control']).toBe('no-store');
    expect(on.body).toMatchObject({ status: 'subscribed', source: 'account', emailVerified: true });
    await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(200);
    expect((await contactOf(email))!.events).toHaveLength(1);

    const off = await b.write('put', '/api/account/consent', { marketingConsent: false }).expect(200);
    expect(off.body).toMatchObject({ status: 'unsubscribed', consentAt: null });
    const contact = await contactOf(email);
    expect(contact).toMatchObject({ status: MarketingStatus.UNSUBSCRIBED, customerId: me.id });
    expect(contact!.unsubscribedAt).toBeInstanceOf(Date);
    expect(contact!.events.map((e) => [e.action, e.source])).toEqual([
      [ConsentAction.CONFIRMED, MarketingConsentSource.ACCOUNT],
      [ConsentAction.WITHDRAWN, MarketingConsentSource.ACCOUNT],
    ]);
    expect((await b.agent.get('/api/account/me').expect(200)).body).toMatchObject({ marketingConsent: false });
  });

  it('contact/change of the e-mail: the old contact is unsubscribed with a released event, nothing moves', async () => {
    const { b, email: old, me } = await signUp({ marketingConsent: true });
    const next = newEmail();
    await b.post('contact/change', { kind: 'email', value: next }).expect(202);
    await b.post('contact/confirm', { kind: 'email', code: emailCode(next) }).expect(200);
    const contact = await contactOf(old);
    expect(contact).toMatchObject({ status: MarketingStatus.UNSUBSCRIBED, customerId: null });
    expect(contact!.events.at(-1)).toMatchObject({ action: ConsentAction.RELEASED });
    expect(await contactOf(next)).toBeNull();
    expect((await b.agent.get('/api/account/consent').expect(200)).body).toMatchObject({ status: null });
    expect(me.marketingConsent).toBe(true);
  });

  it('a website sign-up that takes an unverified store e-mail releases its contact', async () => {
    const email = newEmail();
    const quick = await prisma.customer.create({
      data: {
        fullName: 'ZZ לקוח חנות',
        phone: newPhone(),
        email,
        phoneVerifiedAt: new Date(),
        createdVia: CustomerOrigin.STORE,
      },
    });
    await prisma.$transaction((tx) =>
      marketing.requestConfirmation(tx, {
        email,
        source: 'store',
        channel: 'sms',
        phone: quick.phone,
        actor: {},
      }),
    );
    expect((await contactOf(email))!.status).toBe(MarketingStatus.PENDING);
    const { me } = await signUp({ email });
    const contact = await contactOf(email);
    expect(contact).toMatchObject({ status: MarketingStatus.UNSUBSCRIBED, customerId: me.id });
    expect(contact!.events.map((e) => e.action)).toEqual([ConsentAction.REQUESTED, ConsentAction.RELEASED]);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: quick.id } })).email).toBeNull();
  });

  it('an unverified e-mail cannot subscribe on the account page: 409 email_not_verified', async () => {
    const phone = newPhone();
    const quick = await prisma.customer.create({
      data: {
        fullName: 'ZZ לקוח חנות',
        phone,
        email: newEmail(),
        phoneVerifiedAt: new Date(),
        createdVia: CustomerOrigin.STORE,
      },
    });
    const b = browser();
    await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202);
    await b.post('otp/verify', { target: phone, code: smsCode(phone) }).expect(200);
    const res = await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(409);
    expect(res.body).toMatchObject({ code: 'email_not_verified' });
    expect(await contactOf(quick.email!)).toBeNull();
    expect((await b.agent.get('/api/account/consent').expect(200)).body).toEqual({
      status: null,
      source: null,
      consentAt: null,
      emailVerified: false,
    });
  });
});
