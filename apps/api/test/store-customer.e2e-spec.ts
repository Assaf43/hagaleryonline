import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { StoreCartView, StoreCustomerLookup } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { CustomerOrigin } from './../src/generated/prisma/client.js';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from './../src/notifications/notification-provider.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const DOMAIN = '@store-customer.e2e.test';
const STOREFRONT = 'http://localhost:4200';
const CONFIRMED = 'store.customer_confirmed';
const CREATED = 'customer.created_in_store';

// Phase 6 §4.1 step 2 and §4.3 (decision 85): the customer at the store tablet proves who they are with a one-time
// code. The seller stays in the admin; no customer session is ever created. Codes are read from the mock providers.
describe('Store customer confirmation (e2e, ADM-18, decision 85)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let throttle: WriteThrottle;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  let owner: AdminBrowser;
  let seller: AdminBrowser;
  let sellerId: number;
  let seq = 0;
  const phones: string[] = [];
  const sentCodes: string[] = [];

  const unique = () => String(++seq).padStart(4, '0') + String(Date.now() % 10_000).padStart(4, '0');
  const newPhone = () => {
    const phone = `05${unique()}`;
    phones.push(phone);
    return phone;
  };
  const newEmail = () => `user${unique()}${DOMAIN}`;

  const smsCode = (to: string) => {
    const call = smsSpy.mock.calls.filter(([m]) => m.to === to).at(-1);
    const code = call ? /(\d{6})/.exec(call[0].text)![1] : undefined;
    if (code) sentCodes.push(code);
    return code;
  };
  const emailCode = (to: string) => {
    const call = emailSpy.mock.calls.filter(([m]) => m.to === to).at(-1);
    const code = call ? /(\d{6})/.exec(call[0].text)![1] : undefined;
    if (code) sentCodes.push(code);
    return code;
  };
  const smsTo = (to: string) => smsSpy.mock.calls.filter(([m]) => m.to === to).length;
  const emailsTo = (to: string) => emailSpy.mock.calls.filter(([m]) => m.to === to).length;
  const noCookie = (res: request.Response) => expect(res.headers['set-cookie']).toBeUndefined();
  const view = (res: request.Response) => res.body as StoreCartView;

  const account = (opts: { email?: string | null; emailVerified?: boolean } = {}) =>
    prisma.customer.create({
      data: {
        fullName: 'ZZ דנה לוי',
        phone: newPhone(),
        email: opts.email === undefined ? newEmail() : opts.email,
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: opts.emailVerified === false ? null : new Date(),
      },
    });

  const cleanup = async () => {
    await prisma.cart.deleteMany({ where: { sellerId: { not: null } } });
    const ids = (
      await prisma.customer.findMany({
        where: { OR: [{ email: { endsWith: DOMAIN } }, { phone: { in: phones } }] },
        select: { id: true },
      })
    ).map((c) => c.id);
    await prisma.otpCode.deleteMany({});
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    throttle = app.get(WriteThrottle);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: seller } = await signInOwnerAnd(app, 'store_seller'));
    sellerId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'store_seller@example.test' } })).id;
  });

  beforeEach(() => {
    throttle.setLimit('store_otp', 30);
    throttle.setLimit('store_lookup', 60);
  });

  /** The website's account API, as a browser on the storefront would call it. */
  const website = (path: string, body: object) =>
    request(app.getHttpServer() as App)
      .post(`/api/account/${path}`)
      .set('Origin', STOREFRONT)
      .send(body);

  afterEach(cleanup);

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('a new phone: one SMS code creates a quick account (phone verified, e-mail not) and confirms it', async () => {
    const phone = newPhone();
    const email = newEmail();
    const newCustomer = { fullName: '  ZZ  רון   כהן ', email: email.toUpperCase() };

    const lookup = await seller.post('/store-cart/customer/lookup', { phone: `+972${phone.slice(1)}` }).expect(200);
    expect(lookup.body as StoreCustomerLookup).toEqual({ exists: false });
    noCookie(lookup);
    // The customer endpoints open the seller's cart when there is none.
    expect(await prisma.cart.count({ where: { sellerId } })).toBe(1);

    await seller.post('/store-cart/customer/code', { phone, channel: 'sms' }).expect(400);
    await seller.post('/store-cart/customer/code', { phone, channel: 'email', newCustomer }).expect(400);
    const sent = await seller.post('/store-cart/customer/code', { phone, channel: 'sms', newCustomer }).expect(204);
    noCookie(sent);
    expect(smsTo(phone)).toBe(1);
    expect(emailsTo(email)).toBe(0);
    expect(await prisma.customer.count({ where: { phone } })).toBe(0);

    const res = await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone), newCustomer })
      .expect(200);
    noCookie(res);
    const created = await prisma.customer.findUniqueOrThrow({ where: { phone } });
    expect(created).toMatchObject({
      fullName: 'ZZ רון כהן',
      email,
      emailVerifiedAt: null,
      passwordHash: null,
      createdVia: CustomerOrigin.STORE,
      createdBySellerId: sellerId,
    });
    expect(created.phoneVerifiedAt).toBeInstanceOf(Date);
    expect(await prisma.customerSession.count({ where: { customerId: created.id } })).toBe(0);
    expect(view(res).customer).toEqual({
      id: created.id,
      fullName: 'ZZ רון כהן',
      phone,
      email,
      emailVerified: false,
      isNew: true,
    });
    const cart = await prisma.cart.findFirstOrThrow({ where: { sellerId } });
    expect(cart.storeCustomerId).toBe(created.id);
    expect(cart.storeConfirmedAt).toBeInstanceOf(Date);
    expect(cart.customerId).toBeNull();

    const audit = await prisma.auditLog.findMany({ where: { action: { in: [CONFIRMED, CREATED] } } });
    expect(audit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ actorId: sellerId, action: CREATED, after: { customerId: created.id } }),
        expect.objectContaining({
          actorId: sellerId,
          action: CONFIRMED,
          after: { customerId: created.id, channel: 'sms' },
        }),
      ]),
    );

    // The code is single use: the same code again does not confirm anything.
    await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone), newCustomer })
      .expect(401);
  });

  it('an existing account by an SMS code, and by a code to its verified e-mail', async () => {
    const customer = await account();
    const lookup = await seller.post('/store-cart/customer/lookup', { phone: customer.phone }).expect(200);
    expect(lookup.body).toEqual({
      exists: true,
      fullName: 'ZZ דנה לוי',
      maskedEmail: `u***${DOMAIN}`,
      emailVerified: true,
    });

    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    const bySms = await seller
      .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code: smsCode(customer.phone) })
      .expect(200);
    noCookie(bySms);
    expect(view(bySms).customer).toMatchObject({ id: customer.id, emailVerified: true, isNew: false });

    await seller.delete('/store-cart/customer').expect(200);
    expect((await prisma.cart.findFirstOrThrow({ where: { sellerId } })).storeCustomerId).toBeNull();

    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'email' }).expect(204);
    expect(emailsTo(customer.email!)).toBe(1);
    const byEmail = await seller
      .post('/store-cart/customer/verify', {
        phone: customer.phone,
        channel: 'email',
        code: emailCode(customer.email!),
      })
      .expect(200);
    noCookie(byEmail);
    expect(view(byEmail).customer?.id).toBe(customer.id);
    expect(await prisma.customerSession.count({ where: { customerId: customer.id } })).toBe(0);
    expect(
      await prisma.auditLog.count({
        where: { action: CONFIRMED, actorId: sellerId, after: { path: ['customerId'], equals: customer.id } },
      }),
    ).toBe(2);
  });

  it('an unverified e-mail is no channel: 409 email_not_verified, the phone still works', async () => {
    const customer = await account({ emailVerified: false });
    const lookup = await seller.post('/store-cart/customer/lookup', { phone: customer.phone }).expect(200);
    expect(lookup.body).toMatchObject({ exists: true, emailVerified: false });
    const refused = await seller
      .post('/store-cart/customer/code', { phone: customer.phone, channel: 'email' })
      .expect(409);
    expect(refused.body).toMatchObject({ code: 'email_not_verified' });
    expect(emailsTo(customer.email!)).toBe(0);
    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
  });

  it('an account without an e-mail must get one at confirmation (saved unverified)', async () => {
    const customer = await account({ email: null, emailVerified: false });
    const lookup = await seller.post('/store-cart/customer/lookup', { phone: customer.phone }).expect(200);
    expect(lookup.body).toMatchObject({ exists: true, maskedEmail: null, emailVerified: false });
    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    const code = smsCode(customer.phone)!;
    // Refused before the code is checked, so no attempt is spent.
    await seller.post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code }).expect(400);
    const email = newEmail();
    const res = await seller
      .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code, newCustomer: { email } })
      .expect(200);
    expect(view(res).customer).toMatchObject({ id: customer.id, email, emailVerified: false });
    expect(await prisma.customer.findUniqueOrThrow({ where: { id: customer.id } })).toMatchObject({
      email,
      emailVerifiedAt: null,
    });
  });

  it('409 email_taken for an e-mail another account holds, verified or not; nothing is sent or released', async () => {
    const verified = await account();
    const unverified = await account({ emailVerified: false });
    for (const holder of [verified, unverified]) {
      const phone = newPhone();
      const res = await seller
        .post('/store-cart/customer/code', {
          phone,
          channel: 'sms',
          newCustomer: { fullName: 'ZZ חדש', email: holder.email },
        })
        .expect(409);
      expect(res.body).toMatchObject({ code: 'email_taken' });
      expect(smsTo(phone)).toBe(0);
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: holder.id } })).email).toBe(holder.email);
    }

    // Taken between the code and the check: the verify refuses too, and creates nothing.
    const phone = newPhone();
    const email = newEmail();
    const newCustomer = { fullName: 'ZZ חדש', email };
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms', newCustomer }).expect(204);
    await account({ email });
    const late = await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone), newCustomer })
      .expect(409);
    expect(late.body).toMatchObject({ code: 'email_taken' });
    expect(await prisma.customer.count({ where: { phone } })).toBe(0);
  });

  it('five wrong codes kill the code: the right one is refused after them', async () => {
    const customer = await account();
    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    const code = smsCode(customer.phone)!;
    const wrong = code === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++)
      await seller
        .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code: wrong })
        .expect(401);
    const res = await seller
      .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code })
      .expect(401);
    expect(res.body).toMatchObject({ code: 'invalid_code' });
    expect((await prisma.cart.findFirstOrThrow({ where: { sellerId } })).storeCustomerId).toBeNull();
  });

  it('throttles per seller, not per IP: two sellers at one IP, only the one over its limit gets 429', async () => {
    // A low per-IP code limit proves the store endpoints never count the store's one IP.
    throttle.setLimit('otp', 5);
    try {
      const send = (who: AdminBrowser) => {
        const phone = newPhone();
        return who.post('/store-cart/customer/code', {
          phone,
          channel: 'sms',
          newCustomer: { fullName: 'ZZ חדש', email: newEmail() },
        });
      };
      for (let i = 0; i < 20; i++) {
        await send(seller).expect(204);
        await send(owner).expect(204);
      }
      for (let i = 0; i < 10; i++) await send(seller).expect(204);
      const over = await send(seller).expect(429);
      expect(over.body).toMatchObject({ code: 'too_many_requests' });
      expect(over.headers['retry-after']).toBeDefined();
      await send(owner).expect(204);
    } finally {
      throttle.setLimit('otp', 100_000);
    }
  });

  it('concurrent first calls open exactly one cart for the seller', async () => {
    const phone = newPhone();
    await Promise.all(
      Array.from({ length: 5 }, () => seller.post('/store-cart/customer/lookup', { phone }).expect(200)),
    );
    expect(await prisma.cart.count({ where: { sellerId, orders: { none: {} } } })).toBe(1);
  });

  it('audit rows never carry a code or a hash', async () => {
    const phone = newPhone();
    const newCustomer = { fullName: 'ZZ חדש', email: newEmail() };
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms', newCustomer }).expect(204);
    await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone), newCustomer })
      .expect(200);
    const rows = JSON.stringify(await prisma.auditLog.findMany({ where: { actorId: sellerId } }));
    expect(sentCodes.length).toBeGreaterThan(0);
    for (const code of sentCodes) expect(rows).not.toContain(code);
    expect(rows).not.toMatch(/hash|code"/i);
  });

  it('a store code is no website code: it neither signs in nor starts a sign-up, and still confirms here', async () => {
    const customer = await account();
    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    const code = smsCode(customer.phone)!;
    const signIn = await website('otp/verify', { target: customer.phone, code, purpose: 'sign_in' }).expect(401);
    expect(signIn.body).toMatchObject({ code: 'invalid_code' });
    expect(signIn.headers['set-cookie']).toBeUndefined();
    await website('otp/verify', { target: customer.phone, code, purpose: 'sign_up' }).expect(401);
    expect(await prisma.customerSession.count({ where: { customerId: customer.id } })).toBe(0);
    await seller.post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code }).expect(200);

    // A new phone's store code does not give a website sign-up ticket either.
    const phone = newPhone();
    const newCustomer = { fullName: 'ZZ חדש', email: newEmail() };
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms', newCustomer }).expect(204);
    const ticket = await website('otp/verify', { target: phone, code: smsCode(phone), purpose: 'sign_up' }).expect(401);
    expect(ticket.body.signUpToken).toBeUndefined();
    expect((await prisma.otpCode.findFirstOrThrow({ where: { target: phone } })).purpose).toBe('STORE_CONFIRM');
  });

  it('a website sign-in code does not confirm a customer at the store', async () => {
    const customer = await account();
    await website('otp/request', { target: customer.phone, channel: 'sms', purpose: 'sign_in' }).expect(202);
    const code = smsCode(customer.phone)!;
    await seller.post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code }).expect(401);
    expect(await prisma.cart.count({ where: { storeCustomerId: customer.id } })).toBe(0);
  });

  it('keeps the per-target limit: a fourth store code within 10 minutes is dropped silently', async () => {
    const customer = await account();
    for (let i = 0; i < 4; i++)
      await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    expect(smsTo(customer.phone)).toBe(3);
    expect(await prisma.otpCode.count({ where: { target: customer.phone } })).toBe(3);
  });

  it('throttles lookups per seller: 429 over the limit, another seller is not affected', async () => {
    throttle.setLimit('store_lookup', 3);
    const phone = newPhone();
    for (let i = 0; i < 3; i++) await seller.post('/store-cart/customer/lookup', { phone }).expect(200);
    const over = await seller.post('/store-cart/customer/lookup', { phone }).expect(429);
    expect(over.body).toMatchObject({ code: 'too_many_requests' });
    expect(over.headers['retry-after']).toBeDefined();
    await owner.post('/store-cart/customer/lookup', { phone }).expect(200);
  });

  it('refuses a seller whose orders.store permission was removed', async () => {
    const customer = await account();
    await owner.patch(`/users/${sellerId}`, { removedPermissions: ['orders.store'], extraPermissions: [] }).expect(200);
    try {
      await seller.post('/store-cart/customer/lookup', { phone: customer.phone }).expect(403);
      await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(403);
      await seller
        .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code: '123456' })
        .expect(403);
      await seller.delete('/store-cart/customer').expect(403);
      expect(smsTo(customer.phone)).toBe(0);
    } finally {
      await owner.patch(`/users/${sellerId}`, { removedPermissions: [], extraPermissions: [] }).expect(200);
    }
  });
});
