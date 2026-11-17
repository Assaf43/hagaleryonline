import type { AddressInfo } from 'node:net';
import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import {
  COUPON_MESSAGES_HE,
  type AccountBenefit,
  type CartView,
  type CheckoutRequest,
  type CheckoutResponse,
  type IssuedPersonalCode,
  type OrderView,
  type ShippingQuote,
} from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { hashPassword } from './../src/auth/passwords.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  DiscountType,
  NotificationChannel,
  OrderStatus,
  PromotionKind,
  PromotionTarget,
  type Prisma,
} from './../src/generated/prisma/client.js';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from './../src/notifications/notification-provider.js';
import { CheckoutService } from './../src/orders/checkout.service.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { issuePersonalCode } from './../src/promotions/personal-codes.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteMarketingContacts } from './test-marketing.js';
import { deleteOrders } from './test-orders.js';
import { uniqueIds } from './unique-ids.js';

const ORIGIN = 'http://localhost:4200';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;
const DAY = 24 * 60 * 60_000;
const CUSTOMER_DOMAIN = '@codes9.e2e.test';
const CUSTOMER_PASSWORD = 'correct horse 9';

// Personal codes (Phase 7c, decisions 90, 93–94, spec §5.2). Runs against the e2e test database; the API listens on an
// ephemeral port so the sandbox "complete" endpoint can deliver its signed webhook over HTTP.
describe('Personal codes (e2e, CLB-04, CLB-05, decisions 93–94)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  /** The Super Admin (every permission but the opt-in ones, so `club.manage` too). */
  let owner: AdminBrowser;
  /** Customer service: no `club.manage`. */
  let service: AdminBrowser;
  /** 50,000 a unit. */
  let lamp: number;
  const uniqueId = uniqueIds(9);

  const http = () => request(app.getHttpServer() as App);
  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    return {
      agent,
      cart: async () => (await agent.get('/api/cart').expect(200)).body as CartView,
      add: (variantId: number, quantity: number) =>
        agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity }).expect(200),
      apply: (code: string) => agent.post('/api/cart/coupon').set('Origin', ORIGIN).send({ code }),
      /** The total the storefront shows: subtotal − discount + the curbside quote. */
      expectedTotal: async () => {
        const view = (await agent.get('/api/cart').expect(200)).body as CartView;
        return view.subtotal - (view.discount?.amount ?? 0) + (await curbside(agent));
      },
      /** Without `expectedTotal`: the total of the cart view read first (a view may drop a code that no longer works). */
      checkout: async (expectedTotal?: number) => {
        let total = expectedTotal;
        if (total === undefined) {
          const view = (await agent.get('/api/cart').expect(200)).body as CartView;
          total = view.subtotal - (view.discount?.amount ?? 0) + (await curbside(agent));
        }
        return agent
          .post('/api/checkout')
          .set('Origin', ORIGIN)
          .send({ ...checkoutBody(), expectedTotal: total });
      },
    };
  };
  const curbside = async (agent: ReturnType<typeof request.agent>) =>
    (
      (
        await agent
          .post('/api/shipping/quote')
          .set('Origin', ORIGIN)
          .send({ localityId: LOCALITY, floor: 0, hasElevator: true })
          .expect(200)
      ).body as ShippingQuote
    ).methods.find((m) => m.method === 'curbside')!.total;
  const checkoutBody = (): Omit<CheckoutRequest, 'expectedTotal'> => ({
    contact: { fullName: 'ZZ דנה כהן', phone: '050-1234567', email: 'dana@example.test' },
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
  });
  const txOf = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return /\/pay\/sandbox\/([\w-]+)$/.exec((res.body as CheckoutResponse).redirectUrl)![1];
  };
  const orderOfTx = async (transactionId: string) =>
    (await prisma.payment.findUniqueOrThrow({ where: { transactionId }, include: { order: true } })).order;
  const complete = (tx: string, outcome: 'success' | 'failure') =>
    http().post(`/api/payments/sandbox/${tx}/complete`).set('Origin', ORIGIN).send({ outcome, installments: 1 });
  const retry = (number: number, token: string) =>
    http().post(`/api/orders/${number}/retry-payment?t=${token}`).set('Origin', ORIGIN);
  const viewOf = async (number: number, token: string) =>
    (await http().get(`/api/orders/${number}?t=${token}`).expect(200)).body as OrderView;
  const refusal = (messageHe: string) => ({ statusCode: 400, code: 'invalid_coupon', field: 'coupon', messageHe });

  const template = (data: Partial<Prisma.PromotionUncheckedCreateInput> = {}) =>
    prisma.promotion.create({
      data: {
        name: 'ZZ קוד אישי',
        kind: PromotionKind.PERSONAL_TEMPLATE,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        validityDays: 30,
        ...data,
      },
    });
  const issue = (templateId: number, customerId: string, now = new Date()) =>
    issuePersonalCode(prisma, { templateId, customerId, issuedById: null, now });

  /** A browser signed in to the account of this e-mail. */
  const signedInAs = async (email: string) => {
    const b = browser();
    await b.agent
      .post('/api/account/sign-in')
      .set('Origin', ORIGIN)
      .send({ email, password: CUSTOMER_PASSWORD })
      .expect(200);
    return b;
  };
  /** A new account (created directly) and a browser signed in to it through the API. */
  const member = async () => {
    const id = uniqueId();
    const email = `user${id}${CUSTOMER_DOMAIN}`;
    const customer = await prisma.customer.create({
      data: {
        fullName: 'ZZ דנה לוי',
        phone: `05${id}`,
        email,
        passwordHash: await hashPassword(CUSTOMER_PASSWORD),
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });
    const b = browser();
    await b.agent
      .post('/api/account/sign-in')
      .set('Origin', ORIGIN)
      .send({ email, password: CUSTOMER_PASSWORD })
      .expect(200);
    return { customer, b };
  };

  /** Website sign-up (decision 80): both codes, read from the mock providers' calls, then the account. */
  const signUp = async () => {
    const id = uniqueId();
    const phone = `05${id}`;
    const email = `new${id}${CUSTOMER_DOMAIN}`;
    const b = browser();
    const post = (path: string, body: object) => b.agent.post(`/api/account/${path}`).set('Origin', ORIGIN).send(body);
    const details = { fullName: 'ZZ נועה חדשה', phone, email, marketingConsent: false };
    await post('sign-up', details).expect(200, { verify: true });
    const codeOf = (calls: { to: string; text: string }[], to: string) =>
      /(\d{6})/.exec(calls.filter((m) => m.to === to).at(-1)!.text)![1];
    const first = await post('otp/verify', {
      target: phone,
      code: codeOf(
        smsSpy.mock.calls.map(([m]) => m),
        phone,
      ),
      purpose: 'sign_up',
    }).expect(200);
    const second = await post('otp/verify', {
      target: email,
      code: codeOf(
        emailSpy.mock.calls.map(([m]) => m),
        email,
      ),
      purpose: 'sign_up',
      signUpToken: first.body.signUpToken,
    }).expect(200);
    await post('sign-up', { ...details, signUpToken: second.body.signUpToken }).expect(200);
    const customer = await prisma.customer.findUniqueOrThrow({ where: { email } });
    return { b, customer };
  };
  const benefits = async (b: ReturnType<typeof browser>) => {
    const res = await b.agent.get('/api/account/benefits').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as AccountBenefit[];
  };
  const runJobs = () => outbox.runDue(100);
  const sentEmails = (to: string) => emailSpy.mock.calls.map(([m]) => m).filter((m) => m.to === to);
  const sentSms = (to: string) => smsSpy.mock.calls.map(([m]) => m).filter((m) => m.to === to);

  const cleanup = async () => {
    await deleteOrders(prisma);
    await prisma.cart.deleteMany();
    await prisma.outboxJob.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.personalCode.deleteMany();
    await prisma.promotion.deleteMany();
    await prisma.customer.deleteMany({ where: { email: { endsWith: CUSTOMER_DOMAIN } } });
    await deleteMarketingContacts(prisma, { email: { endsWith: CUSTOMER_DOMAIN } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    // resetAdminData TRUNCATEs admin_users CASCADE (customers, orders and codes go too): every fixture comes after it.
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: service } = await signInOwnerAnd(app, 'customer_service'));
    await prisma.product.deleteMany({ where: { modelName: 'ZZCODES' } });
    await prisma.category.deleteMany({ where: { slug: 'zz-codes' } });
    const category = await prisma.category.create({
      data: {
        slug: 'zz-codes',
        nameHe: 'בדיקת קודים',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const product = await prisma.product.create({
      data: {
        slug: 'zz-codes-lamp',
        modelName: 'ZZCODES',
        nameHe: 'מנורת קודים',
        categoryId: category.id,
        variants: {
          create: [
            {
              sku: 'ZZCODES-1',
              price: 50_000,
              stock: 100,
              sortOrder: 0,
              widthCm: 50,
              depthCm: 50,
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

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await prisma.product.deleteMany({ where: { modelName: 'ZZCODES' } });
    await prisma.category.deleteMany({ where: { slug: 'zz-codes' } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  afterEach(cleanup);

  it('issues "NST-" codes valid for the template days, never past its end', async () => {
    const t = await template({ validityDays: 30 });
    const { customer } = await member();
    const now = new Date();
    const issued = await issue(t.id, customer.id, now);
    expect(issued.code).toMatch(/^NST-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(issued.expiresAt).toEqual(new Date(now.getTime() + 30 * DAY));
    expect(await prisma.personalCode.findUniqueOrThrow({ where: { code: issued.code } })).toMatchObject({
      promotionId: t.id,
      customerId: customer.id,
      issuedById: null,
      orderId: null,
    });

    const endsAt = new Date(now.getTime() + 2 * DAY);
    const short = await template({ name: 'ZZ קצר', endsAt });
    expect((await issue(short.id, customer.id, now)).expiresAt).toEqual(endsAt);
    // Only from an active template.
    const off = await template({ name: 'ZZ כבוי', active: false });
    await expect(issue(off.id, customer.id, now)).rejects.toThrow();
    const automatic = await prisma.promotion.create({
      data: {
        name: 'ZZ אוטומטי',
        kind: PromotionKind.AUTOMATIC,
        discountType: DiscountType.PERCENT,
        value: 5,
        target: PromotionTarget.ORDER,
      },
    });
    await expect(issue(automatic.id, customer.id, now)).rejects.toThrow();
  });

  it('the owner uses the code once: the order holds it, paying marks it used and counts the template', async () => {
    const t = await template({ name: 'ZZ עשרה אחוז' });
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 2);
    // Entered as typed by a person: lower-case with spaces.
    const view = (await b.apply(`  ${code.toLowerCase()} `).expect(200)).body as CartView;
    expect(view.couponCode).toBe(code);
    expect(view.discount).toEqual({ labelHe: 'ZZ עשרה אחוז', amount: 10_000, source: 'coupon', code });

    const tx = txOf(await b.checkout());
    const order = await orderOfTx(tx);
    const held = await prisma.personalCode.findUniqueOrThrow({ where: { code } });
    expect(order).toMatchObject({
      customerId: customer.id,
      discount: 10_000,
      promotionId: t.id,
      personalCodeId: held.id,
      discountInfo: { name: 'ZZ עשרה אחוז', kind: 'coupon', code, labelHe: 'ZZ עשרה אחוז', source: 'coupon' },
    });
    expect(held.orderId).toBeNull();

    await complete(tx, 'success').expect(200);
    expect((await prisma.personalCode.findUniqueOrThrow({ where: { code } })).orderId).toBe(order.id);
    expect((await prisma.promotion.findUniqueOrThrow({ where: { id: t.id } })).usedCount).toBe(1);

    // Used: refused with the used-up wording, and the code no longer applies.
    await b.add(lamp, 1);
    expect((await b.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.exhausted));
    expect((await b.cart()).discount).toBeNull();
  });

  it("another account's code answers like an unknown code; a guest is asked to sign in", async () => {
    const t = await template();
    const { customer } = await member();
    const { code } = await issue(t.id, customer.id);

    const { b: other } = await member();
    // No cart yet: the owner's code is valid but has nothing to apply to; another account's is unknown.
    const ownerBrowser = await signedInAs(customer.email!);
    expect((await ownerBrowser.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.not_applicable));
    expect((await other.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.unknown));
    await other.add(lamp, 1);
    expect((await other.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.unknown));
    expect((await other.apply('NST-ZZZZZZZZ').expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.unknown));

    const guest = browser();
    await guest.add(lamp, 1);
    expect((await guest.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.members_only));
    expect((await guest.cart()).discount).toBeNull();
  });

  it('a deactivated template voids its unused codes; an expired code is refused as expired', async () => {
    const t = await template();
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    await prisma.promotion.update({ where: { id: t.id }, data: { active: false } });
    // The cart drops it once, with the unknown wording.
    const view = await b.cart();
    expect(view.discount).toBeNull();
    expect(view.couponCode).toBeNull();
    expect(view.notices).toEqual([{ variantId: null, kind: 'coupon', messageHe: COUPON_MESSAGES_HE.unknown }]);
    expect((await b.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.unknown));

    await prisma.promotion.update({ where: { id: t.id }, data: { active: true } });
    await prisma.personalCode.update({ where: { code }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect((await b.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.expired));
  });

  it('edits to the template apply to its unused codes (terms are read when the code is used)', async () => {
    const t = await template({ value: 10 });
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 2);
    expect(((await b.apply(code).expect(200)).body as CartView).discount?.amount).toBe(10_000);
    await prisma.promotion.update({
      where: { id: t.id },
      data: { value: 20, minSubtotal: 0, name: 'ZZ עשרים אחוז' },
    });
    expect((await b.cart()).discount).toEqual({ labelHe: 'ZZ עשרים אחוז', amount: 20_000, source: 'coupon', code });
    // A minimum raised above the cart: kept, with the minimum notice.
    await prisma.promotion.update({ where: { id: t.id }, data: { minSubtotal: 200_000 } });
    const view = await b.cart();
    expect(view.discount).toBeNull();
    expect(view.couponCode).toBe(code);
  });

  it('the welcome code: no automatic welcome discount any more; first order only (decision 93)', async () => {
    const welcome = await template({ name: 'ZZ הטבת הצטרפות', isWelcome: true });
    const { customer, b } = await member();
    await b.add(lamp, 1);
    // Signed in, no paid order, an active welcome template: no discount without the code.
    expect((await b.cart()).discount).toBeNull();
    const first = await orderOfTx(txOf(await b.checkout()));
    expect(first).toMatchObject({ discount: 0, promotionId: null, personalCodeId: null });

    // The code works while the account has no paid order…
    const { code } = await issue(welcome.id, customer.id);
    await b.add(lamp, 1);
    // The first order is not paid: its line is still in the cart (2 lamps).
    expect(((await b.apply(code).expect(200)).body as CartView).discount?.amount).toBe(10_000);
    await b.agent.delete('/api/cart/coupon').set('Origin', ORIGIN).expect(200);
    // …and not after it: a paid order without the code.
    const tx = txOf(await b.checkout());
    await complete(tx, 'success').expect(200);
    await b.add(lamp, 1);
    expect((await b.apply(code).expect(400)).body).toEqual(refusal(COUPON_MESSAGES_HE.first_order_only));
    expect((await prisma.personalCode.findUniqueOrThrow({ where: { code } })).orderId).toBeNull();

    // An ordinary personal code still works after a paid order.
    const other = await template({ name: 'ZZ קוד צוות' });
    const staff = await issue(other.id, customer.id);
    expect(((await b.apply(staff.code).expect(200)).body as CartView).discount?.amount).toBe(5_000);
  });

  it('personal code held by live order: a second pending order is refused; paying the first marks it used', async () => {
    const t = await template();
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const total = await b.expectedTotal();
    const tx = txOf(await b.checkout(total));
    const first = await orderOfTx(tx);
    // Outside the cart (as after a merge that detached it, or a store cart): the next checkout does not supersede it.
    await prisma.order.update({ where: { id: first.id }, data: { cartId: null } });

    // The cart still has the code (no view read since): while the first order waits for payment it holds it.
    const second = await b.checkout(total);
    expect(second.status, JSON.stringify(second.body)).toBe(409);
    expect(second.body).toMatchObject({ code: 'coupon_invalid', messageHe: COUPON_MESSAGES_HE.exhausted });
    expect(await prisma.order.count({ where: { personalCodeId: { not: null } } })).toBe(1);
    // The cart view says so once and drops the code.
    const view = await b.cart();
    expect(view.discount).toBeNull();
    expect(view.couponCode).toBeNull();
    expect(view.notices).toEqual([{ variantId: null, kind: 'coupon', messageHe: COUPON_MESSAGES_HE.exhausted }]);

    await complete(tx, 'success').expect(200);
    expect((await prisma.personalCode.findUniqueOrThrow({ where: { code } })).orderId).toBe(first.id);
  });

  it('two checkouts of one account from two carts at once: exactly one order gets the code', async () => {
    const t = await template();
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const total = await b.expectedTotal();
    // A second cart of the same account's customer (as a seller's store cart is): a guest cart with the code.
    const guest = browser();
    const added = await guest.add(lamp, 1);
    const token = /hg_cart=([^;]+)/.exec(String(added.headers['set-cookie']))![1];
    await prisma.cart.updateMany({ where: { customerId: null, sellerId: null }, data: { couponCode: code } });

    // Hold the account's checkout lock while both start, so both wait on it and then run one after the other.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'welcome:' + customer.id}::text))`;
        await gate;
      },
      { timeout: 20_000 },
    );
    const input = { ...checkoutBody(), expectedTotal: total };
    const checkout = app.get(CheckoutService);
    const racing = Promise.allSettled([
      checkout.placeOrder({ token: undefined, customerId: customer.id }, input, {
        customerId: customer.id,
        channel: 'web',
      }),
      checkout.placeOrder({ token, customerId: null }, input, { customerId: customer.id, channel: 'web' }),
    ]);
    await new Promise((resolve) => setTimeout(resolve, 600));
    release();
    await holder;
    const results = await racing;

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toMatchObject({ code: 'coupon_invalid' });
    const holding = await prisma.order.findMany({ where: { personalCodeId: { not: null } } });
    expect(holding).toHaveLength(1);
    expect(holding[0]).toMatchObject({ status: OrderStatus.PENDING_PAYMENT, discount: 5_000 });
  });

  it('retry of an order holding a code: refused once the code is used, expired or its template is off', async () => {
    const t = await template();
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const tx = txOf(await b.checkout());
    await complete(tx, 'failure').expect(200);
    const failed = await orderOfTx(tx);
    expect(failed.personalCodeId).not.toBeNull();
    await prisma.order.update({ where: { id: failed.id }, data: { cartId: null } });
    expect((await viewOf(failed.number, failed.publicToken)).canRetryPayment).toBe(true);

    // Template off → refused; on again → the retry goes through.
    await prisma.promotion.update({ where: { id: t.id }, data: { active: false } });
    expect((await retry(failed.number, failed.publicToken).expect(409)).body.code).toBe('promotion_ended');
    await prisma.promotion.update({ where: { id: t.id }, data: { active: true } });
    // Expired → refused.
    await prisma.personalCode.update({ where: { code }, data: { expiresAt: new Date(Date.now() - 1_000) } });
    expect((await retry(failed.number, failed.publicToken).expect(409)).body.code).toBe('promotion_ended');
    await prisma.personalCode.update({ where: { code }, data: { expiresAt: new Date(Date.now() + DAY) } });

    // Another order of the account used it meanwhile → refused.
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const other = txOf(await b.checkout());
    await complete(other, 'success').expect(200);
    expect((await prisma.personalCode.findUniqueOrThrow({ where: { code } })).orderId).toBe(
      (await orderOfTx(other)).id,
    );
    expect((await retry(failed.number, failed.publicToken).expect(409)).body.code).toBe('promotion_ended');
  });

  it('retry: refused while another live order holds the code; a welcome code after a paid order', async () => {
    const welcome = await template({ name: 'ZZ הטבת הצטרפות', isWelcome: true });
    const { customer, b } = await member();
    const { code } = await issue(welcome.id, customer.id);
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const tx = txOf(await b.checkout());
    await complete(tx, 'failure').expect(200);
    const failed = await orderOfTx(tx);
    await prisma.order.update({ where: { id: failed.id }, data: { cartId: null } });

    // A second order holds the code (the failed one released it).
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const holding = txOf(await b.checkout());
    expect((await retry(failed.number, failed.publicToken).expect(409)).body.code).toBe('promotion_ended');
    await complete(holding, 'failure').expect(200);
    // Released again: the failed order's retry would work, until the account pays an order without the code.
    const holdingOrder = await orderOfTx(holding);
    await prisma.order.update({ where: { id: holdingOrder.id }, data: { cartId: null } });
    await b.add(lamp, 1);
    await b.agent.delete('/api/cart/coupon').set('Origin', ORIGIN).expect(200);
    await complete(txOf(await b.checkout()), 'success').expect(200);
    expect((await retry(failed.number, failed.publicToken).expect(409)).body.code).toBe('promotion_ended');
  });

  it('a late payment of an order whose code another paid order used is honored, and the code keeps its first use', async () => {
    const t = await template();
    const { customer, b } = await member();
    const { code } = await issue(t.id, customer.id);
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const firstTx = txOf(await b.checkout());
    const first = await orderOfTx(firstTx);
    // Its reservation ran out and it left the cart: the code is free for another order.
    await prisma.order.update({
      where: { id: first.id },
      data: { cartId: null, reservedUntil: new Date(Date.now() - 1_000) },
    });
    await b.add(lamp, 1);
    await b.apply(code).expect(200);
    const secondTx = txOf(await b.checkout());
    await complete(secondTx, 'success').expect(200);
    const second = await orderOfTx(secondTx);

    await complete(firstTx, 'success').expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.id } })).status).toBe(OrderStatus.PAID);
    expect((await prisma.personalCode.findUniqueOrThrow({ where: { code } })).orderId).toBe(second.id);
  });

  describe('issuing (CLB-04, CLB-05, decisions 93–94)', () => {
    it('website sign-up with an active welcome template: one welcome code, one welcome_code e-mail with it', async () => {
      const welcome = await template({ name: 'ZZ הטבת הצטרפות', isWelcome: true, validityDays: 30 });
      const before = new Date();
      const { b, customer } = await signUp();
      const codes = await prisma.personalCode.findMany({ where: { customerId: customer.id } });
      expect(codes).toHaveLength(1);
      const [issued] = codes;
      expect(issued).toMatchObject({ promotionId: welcome.id, issuedById: null, orderId: null });
      expect(issued.expiresAt.getTime()).toBeGreaterThanOrEqual(before.getTime() + 30 * DAY);

      // One message job, which carries the code's id only; never the code in a job or in the audit log.
      const jobs = await prisma.outboxJob.findMany({ where: { type: { contains: 'code' } } });
      expect(jobs.map((j) => [j.type, j.dedupeKey])).toEqual([['email.welcome_code', `welcome_code:${issued.id}`]]);
      expect(JSON.stringify(jobs)).not.toContain(issued.code);
      expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(issued.code);

      await runJobs();
      const mails = sentEmails(customer.email!).filter((m) => m.text.includes(issued.code));
      expect(mails).toHaveLength(1);
      expect(mails[0].html).toContain(`<bdi>${issued.code}</bdi>`);
      expect(mails[0].text).toContain('ZZ הטבת הצטרפות');
      expect(
        await prisma.notificationLog.count({ where: { template: 'welcome_code', channel: NotificationChannel.EMAIL } }),
      ).toBe(1);

      expect(await benefits(b)).toEqual([
        {
          code: issued.code,
          labelHe: 'ZZ הטבת הצטרפות',
          expiresAt: issued.expiresAt.toISOString(),
          status: 'active',
        },
      ]);
      // The code works for its owner at once.
      await b.add(lamp, 1);
      expect(((await b.apply(issued.code).expect(200)).body as CartView).discount?.amount).toBe(5_000);
    });

    it('no active welcome template: sign-up still succeeds, with no code and no message', async () => {
      await template({ name: 'ZZ הצטרפות כבויה', isWelcome: true, active: false });
      await template({ name: 'ZZ קוד צוות' });
      const { b, customer } = await signUp();
      expect(await prisma.personalCode.count({ where: { customerId: customer.id } })).toBe(0);
      expect(await prisma.outboxJob.count({ where: { type: { contains: 'code' } } })).toBe(0);
      expect(await benefits(b)).toEqual([]);
    });

    it('a welcome template whose end has passed gives no code', async () => {
      await template({ name: 'ZZ הצטרפות שהסתיימה', isWelcome: true, endsAt: new Date(Date.now() - DAY) });
      const { customer } = await signUp();
      expect(await prisma.personalCode.count({ where: { customerId: customer.id } })).toBe(0);
    });

    it('"ההטבות שלי" lists the own codes, newest first, as active, used or expired; it needs a session', async () => {
      const t = await template({ name: 'ZZ עשרה אחוז' });
      const off = await template({ name: 'ZZ תבנית שכובתה' });
      const welcome = await template({ name: 'ZZ הטבת הצטרפות', isWelcome: true });
      const { customer, b } = await member();
      const used = await issue(t.id, customer.id, new Date(Date.now() - 5_000));
      const expired = await issue(t.id, customer.id, new Date(Date.now() - 4_000));
      const voided = await issue(off.id, customer.id, new Date(Date.now() - 3_000));
      const welcomeCode = await issue(welcome.id, customer.id, new Date(Date.now() - 2_000));
      const active = await issue(t.id, customer.id);
      await prisma.personalCode.update({
        where: { code: expired.code },
        data: { expiresAt: new Date(Date.now() - 1) },
      });
      await prisma.promotion.update({ where: { id: off.id }, data: { active: false } });
      // Another account's code is never listed.
      const { customer: other } = await member();
      await issue(t.id, other.id);

      // The welcome code is active until the account has a paid order (paid here with another code).
      const statuses = async () => Object.fromEntries((await benefits(b)).map((x) => [x.code, x.status]));
      expect((await statuses())[welcomeCode.code]).toBe('active');
      await b.add(lamp, 1);
      await b.apply(used.code).expect(200);
      await complete(txOf(await b.checkout()), 'success').expect(200);

      const list = await benefits(b);
      expect(list.map((x) => x.code)).toEqual([active.code, welcomeCode.code, voided.code, expired.code, used.code]);
      expect(await statuses()).toEqual({
        [active.code]: 'active',
        [welcomeCode.code]: 'expired',
        [voided.code]: 'expired',
        [expired.code]: 'expired',
        [used.code]: 'used',
      });
      expect(list[0]).toEqual({
        code: active.code,
        labelHe: 'ZZ עשרה אחוז',
        expiresAt: active.expiresAt.toISOString(),
        status: 'active',
      });

      await browser().agent.get('/api/account/benefits').expect(401);
    });

    it('staff issue a personal code (club.manage): sent by SMS, audited with the template id only', async () => {
      const t = await template({ name: 'ZZ קוד צוות', validityDays: 14 });
      const { customer } = await member();
      const res = await owner.post(`/customers/${customer.id}/codes`, { templateId: t.id, send: 'sms' });
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      const issued = res.body as IssuedPersonalCode;
      expect(issued.code).toMatch(/^NST-[A-Z2-9]{8}$/);
      const row = await prisma.personalCode.findUniqueOrThrow({ where: { code: issued.code } });
      const ownerId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'owner@example.test' } })).id;
      expect(row).toMatchObject({ promotionId: t.id, customerId: customer.id, issuedById: ownerId });
      expect(issued.expiresAt).toBe(row.expiresAt.toISOString());

      const audit = await prisma.auditLog.findMany({ where: { action: 'customer.code_issued' } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: ownerId, entityType: 'customer', entityId: customer.id });
      expect(audit[0].after).toEqual({ templateId: t.id });
      expect(JSON.stringify(await prisma.auditLog.findMany())).not.toContain(issued.code);

      const jobs = await prisma.outboxJob.findMany({ where: { type: { contains: 'code' } } });
      expect(jobs.map((j) => [j.type, j.dedupeKey])).toEqual([['sms.personal_code', `personal_code:${row.id}`]]);
      expect(JSON.stringify(jobs)).not.toContain(issued.code);
      await runJobs();
      const sms = sentSms(customer.phone).filter((m) => m.text.includes(issued.code));
      expect(sms).toHaveLength(1);
      expect(sms[0].text).toContain('ZZ קוד צוות');
      expect(
        await prisma.notificationLog.count({ where: { template: 'personal_code', channel: NotificationChannel.SMS } }),
      ).toBe(1);

      // By e-mail (verified), or not sent at all.
      const byMail = (
        await owner.post(`/customers/${customer.id}/codes`, { templateId: t.id, send: 'email' }).expect(201)
      ).body as IssuedPersonalCode;
      const handed = (
        await owner.post(`/customers/${customer.id}/codes`, { templateId: t.id, send: 'none' }).expect(201)
      ).body as IssuedPersonalCode;
      await runJobs();
      expect(sentEmails(customer.email!).filter((m) => m.html.includes(`<bdi>${byMail.code}</bdi>`))).toHaveLength(1);
      expect(sentEmails(customer.email!).some((m) => m.text.includes(handed.code))).toBe(false);
      expect(sentSms(customer.phone).some((m) => m.text.includes(handed.code))).toBe(false);
      expect(await prisma.outboxJob.count({ where: { type: { contains: 'code' } } })).toBe(2);
    });

    it('staff issue: refusals, and 403 without club.manage', async () => {
      const t = await template({ name: 'ZZ קוד צוות' });
      const { customer } = await member();
      const issueFor = (customerId: string, body: object) => owner.post(`/customers/${customerId}/codes`, body);

      await service.post(`/customers/${customer.id}/codes`, { templateId: t.id, send: 'none' }).expect(403);
      await issueFor('00000000-0000-4000-8000-000000000000', { templateId: t.id, send: 'none' }).expect(404);
      await issueFor('not-a-uuid', { templateId: t.id, send: 'none' }).expect(404);
      expect((await issueFor(customer.id, { templateId: t.id, send: 'fax' }).expect(400)).body).toMatchObject({
        code: 'invalid',
        field: 'send',
      });
      expect((await issueFor(customer.id, { templateId: 'x', send: 'none' }).expect(400)).body).toMatchObject({
        code: 'invalid',
        field: 'templateId',
      });
      const off = await template({ name: 'ZZ כבויה', active: false });
      const ended = await template({ name: 'ZZ שהסתיימה', endsAt: new Date(Date.now() - DAY) });
      const coupon = await prisma.promotion.create({
        data: {
          name: 'ZZ קופון',
          kind: PromotionKind.COUPON,
          code: 'ZZCOUPON',
          discountType: DiscountType.PERCENT,
          value: 5,
          target: PromotionTarget.ORDER,
        },
      });
      for (const templateId of [off.id, ended.id, coupon.id, 999_999])
        expect((await issueFor(customer.id, { templateId, send: 'none' }).expect(400)).body).toMatchObject({
          code: 'invalid',
          field: 'templateId',
        });

      // An unverified e-mail (a store quick account) cannot receive it; nothing is issued.
      const quick = await prisma.customer.create({
        data: {
          fullName: 'ZZ רון',
          phone: `05${uniqueId()}`,
          email: `quick${uniqueId()}${CUSTOMER_DOMAIN}`,
          phoneVerifiedAt: new Date(),
        },
      });
      expect((await issueFor(quick.id, { templateId: t.id, send: 'email' }).expect(409)).body).toMatchObject({
        code: 'email_not_verified',
        field: 'send',
      });
      expect(await prisma.personalCode.count()).toBe(0);
      expect(await prisma.auditLog.count({ where: { action: 'customer.code_issued', entityId: quick.id } })).toBe(0);
      // By SMS it can.
      await issueFor(quick.id, { templateId: t.id, send: 'sms' }).expect(201);
    });
  });
});
