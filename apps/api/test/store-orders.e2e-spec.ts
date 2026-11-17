import type { AddressInfo } from 'node:net';
import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type {
  CartView,
  CheckoutResponse,
  CustomerAddressView,
  OneTimeLink,
  SandboxCompleteResponse,
  ShippingQuote,
  StoreCartView,
  StoreOrderCreated,
  StoreOrderStatus,
  StorePendingOrder,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  ConsentAction,
  DiscountType,
  MarketingConsentSource,
  MarketingStatus,
  OrderActorType,
  OrderChannel,
  OrderStatus,
  PromotionKind,
  PromotionTarget,
} from './../src/generated/prisma/client.js';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from './../src/notifications/notification-provider.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { MarketingService } from './../src/marketing/marketing.service.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteMarketingContacts } from './test-marketing.js';
import { deleteOrders } from './test-orders.js';
import { uniqueIds } from './unique-ids.js';

const STOREFRONT = 'http://localhost:4200';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;
const DOMAIN = '@store-orders.e2e.test';
const HOUR_MS = 60 * 60_000;

// Phase 6 §4.1 steps 3–5, §4.4, §4.7 (ADM-18, CHK-11, decisions 84–87): the seller's store cart, with a confirmed
// customer, becomes an order on the website's checkout path, and the customer pays at once on the provider's page on
// the tablet. The API listens on a real port so the sandbox "complete" delivers its signed webhook over HTTP.
describe('Store orders (e2e, ADM-18, CHK-11, decision 84)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let throttle: WriteThrottle;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  let owner: AdminBrowser;
  let sellerA: AdminBrowser;
  let sellerB: AdminBrowser;
  let sellerAId: number;
  let storeId: number;
  /** One unit in stock. */
  let last: number;
  /** Plenty in stock. */
  let plenty: number;

  const unique = uniqueIds(6);
  const newPhone = () => `05${unique()}`;
  const newEmail = () => `user${unique()}${DOMAIN}`;
  const http = () => request(app.getHttpServer() as App);
  const smsCode = (to: string) => {
    const call = smsSpy.mock.calls.filter(([m]) => m.to === to).at(-1);
    return /(\d{6})/.exec(call![0].text)![1];
  };
  const stockOf = async (id: number) => (await prisma.variant.findUniqueOrThrow({ where: { id } })).stock;

  const address = {
    localityId: LOCALITY,
    street: 'הרצל',
    houseNumber: '12',
    apartment: '4',
    floor: 4,
    hasElevator: false,
    notes: null,
  };
  const orderBody = (patch: Record<string, unknown> = {}) => ({
    address,
    method: 'curbside',
    acceptTerms: true,
    ...patch,
  });

  /**
   * POST /api/admin/store-orders with the total the server computes: a first call with `expectedTotal: 0` answers
   * 409 `price_changed` with it (nothing is created), then the real call is sent with that total.
   */
  const placeStore = async (seller: AdminBrowser, patch: Record<string, unknown> = {}) => {
    const probe = await seller.post('/store-orders', { ...orderBody(patch), expectedTotal: 0 });
    if (probe.status !== 409 || probe.body.code !== 'price_changed') return probe;
    return seller.post('/store-orders', { ...orderBody(patch), expectedTotal: probe.body.total as number });
  };
  const txOf = (redirectUrl: string) => {
    const match = new RegExp(`^${STOREFRONT}/pay/sandbox/([\\w-]+)$`).exec(redirectUrl);
    if (!match) throw new Error(`unexpected redirect ${redirectUrl}`);
    return match[1];
  };
  const complete = (tx: string, outcome: 'success' | 'failure' | 'cancel') =>
    http().post(`/api/payments/sandbox/${tx}/complete`).set('Origin', STOREFRONT).send({ outcome, installments: 1 });
  const orderOf = (number: number) => prisma.order.findUniqueOrThrow({ where: { number }, include: { items: true } });

  /** A new phone: one SMS code creates the quick account and attaches it to the seller's open cart. */
  const quickAccount = async (seller: AdminBrowser, opts: { fullName?: string } = {}) => {
    const phone = newPhone();
    const newCustomer = { fullName: opts.fullName ?? 'ZZ רון כהן', email: newEmail() };
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms', newCustomer }).expect(204);
    const res = await seller
      .post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone), newCustomer })
      .expect(200);
    return { ...(res.body as StoreCartView).customer!, newCustomer };
  };
  const existingAccount = (data: { email?: string | null } = {}) =>
    prisma.customer.create({
      data: {
        fullName: 'ZZ דנה לוי',
        phone: newPhone(),
        email: data.email === undefined ? newEmail() : data.email,
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: data.email === null ? null : new Date(),
      },
    });
  /** Confirms an existing account on the seller's open cart by an SMS code. */
  const confirm = async (seller: AdminBrowser, phone: string) => {
    await seller.post('/store-cart/customer/code', { phone, channel: 'sms' }).expect(204);
    await seller.post('/store-cart/customer/verify', { phone, channel: 'sms', code: smsCode(phone) }).expect(200);
  };
  const newSale = async (seller: AdminBrowser, lines: [number, number][]) => {
    await seller.post('/store-cart').expect(201);
    for (const [variantId, quantity] of lines)
      await seller.post('/store-cart/items', { variantId, quantity }).expect(201);
  };

  const cleanData = async () => {
    await deleteOrders(prisma, { OR: [{ contact: { path: ['fullName'], string_starts_with: 'ZZ' } }] });
    await prisma.cart.deleteMany();
    await prisma.outboxJob.deleteMany({});
    await prisma.otpCode.deleteMany({});
    await prisma.personalCode.deleteMany({ where: { promotion: { name: { startsWith: 'ZZ' } } } });
    await prisma.promotion.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
    await prisma.customer.deleteMany({ where: { fullName: { startsWith: 'ZZ' } } });
    await deleteMarketingContacts(prisma, { email: { endsWith: DOMAIN } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    throttle = app.get(WriteThrottle);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    // resetAdminData TRUNCATEs admin_users CASCADE (seller-linked rows go too): every fixture comes after it.
    await resetAdminData(prisma);
    await cleanData();
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-sto' } } });
    const signedIn = await signInOwnerAnd(app, 'store_seller');
    owner = signedIn.owner;
    sellerA = signedIn.other;
    sellerAId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'store_seller@example.test' } })).id;
    const invited = await signedIn.owner
      .post('/users', { email: 'seller_b@example.test', name: 'מוכר ב', template: 'store_seller' })
      .expect(201);
    sellerB = await acceptAndSignIn(
      app,
      { email: 'seller_b@example.test', password: 'granite chair morning tide' },
      invited.body.invite as OneTimeLink,
    );
    storeId = (await prisma.store.findFirstOrThrow({ where: { active: true }, orderBy: { id: 'asc' } })).id;

    const category = await prisma.category.create({
      data: {
        slug: 'zz-sto',
        nameHe: 'בדיקת חנות',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const size = { widthCm: 200, depthCm: 90, heightCm: 80, leadTimeDays: 7 };
    const product = await prisma.product.create({
      data: {
        slug: 'zz-sto-sofa',
        modelName: 'ZZSTO',
        nameHe: 'ספת חנות',
        categoryId: category.id,
        variants: {
          create: [
            { sku: 'ZZSTO-LAST', price: 100_000, stock: 1, sortOrder: 0, ...size },
            { sku: 'ZZSTO-PLENTY', price: 50_000, stock: 50, sortOrder: 1, ...size },
          ],
        },
      },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    [last, plenty] = product.variants.map((v) => v.id);
    await app.get(CacheStore).invalidate('catalog:');
  });

  beforeEach(() => {
    throttle.setLimit('store_otp', 100);
    throttle.setLimit('store_lookup', 100);
    throttle.setLimit('store_verify', 100);
  });

  afterEach(async () => {
    await cleanData();
    await prisma.variant.update({ where: { id: last }, data: { stock: 1 } });
    await prisma.variant.update({ where: { id: plenty }, data: { stock: 50 } });
  });

  afterAll(async () => {
    await cleanData();
    await resetAdminData(prisma);
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-sto' } } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  it('new customer sale end to end: quick account → store order → /pay/done → paid, e-mails, store_welcome once', async () => {
    await newSale(sellerA, [[plenty, 2]]);
    const customer = await quickAccount(sellerA);
    const res = await placeStore(sellerA, { marketingConsent: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.headers['set-cookie']).toBeUndefined();
    const created = res.body as StoreOrderCreated;
    const order = await orderOf(created.number);
    expect(order).toMatchObject({
      channel: OrderChannel.STORE,
      sellerId: sellerAId,
      storeId,
      customerId: customer.id,
      status: OrderStatus.PENDING_PAYMENT,
      contact: { fullName: 'ZZ רון כהן', phone: customer.phone, email: customer.newCustomer.email },
      marketingConsent: true,
    });
    // The seller's box asks the customer by SMS (decision 96): pending until they confirm, source `store`; the
    // quick account's e-mail is unverified, so the contact is not linked to it.
    expect(await prisma.marketingContact.findUnique({ where: { email: customer.newCustomer.email } })).toMatchObject({
      status: MarketingStatus.PENDING,
      source: MarketingConsentSource.STORE,
      customerId: null,
    });
    expect(await prisma.outboxJob.count({ where: { type: 'sms.store_consent' } })).toBe(1);
    // The delivery address is saved to the account, as its default (it had none).
    expect(await prisma.customerAddress.findMany({ where: { customerId: customer.id } })).toEqual([
      expect.objectContaining({ ...address, isDefault: true }),
    ]);
    expect(
      await prisma.auditLog.findFirst({ where: { action: 'store_order.create', entityId: String(created.number) } }),
    ).toMatchObject({ actorId: sellerAId, after: { number: created.number, customerId: customer.id } });

    // The seller screen follows the order.
    expect((await sellerA.get(`/store-orders/${created.number}`).expect(200)).body as StoreOrderStatus).toEqual({
      number: created.number,
      status: 'pending_payment',
      total: order.total,
    });
    const pending = (await sellerA.get('/store-orders/pending').expect(200)).body as StorePendingOrder[];
    expect(pending).toEqual([
      {
        number: created.number,
        fullName: 'ZZ רון כהן',
        total: order.total,
        status: 'pending_payment',
        reservedUntil: order.reservedUntil.toISOString(),
        actions: ['retry', 'cancel'],
      },
    ]);

    // Paid on the tablet: the provider returns to the short page, never the tokened confirmation link.
    const done = (await complete(txOf(created.redirectUrl), 'success').expect(200)).body as SandboxCompleteResponse;
    expect(done).toEqual({ confirmationUrl: '/pay/done' });
    const paid = await orderOf(created.number);
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(await stockOf(plenty)).toBe(48);
    expect((await sellerA.get(`/store-orders/${created.number}`).expect(200)).body).toMatchObject({ status: 'paid' });
    expect((await sellerA.get('/store-orders/pending').expect(200)).body).toEqual([]);
    const jobs = await prisma.outboxJob.findMany({ select: { type: true, dedupeKey: true } });
    expect(jobs).toEqual(
      expect.arrayContaining([
        { type: 'email.order_paid', dedupeKey: `email.order_paid:${paid.id}` },
        { type: 'invoice.issue', dedupeKey: `invoice.issue:${paid.id}` },
        { type: 'email.store_welcome', dedupeKey: `store_welcome:${customer.id}` },
      ]),
    );

    // The welcome e-mail goes to the account's address and never mentions the store.
    emailSpy.mockClear();
    await outbox.runDue(100);
    const welcome = emailSpy.mock.calls.find(
      ([m]) => m.to === customer.newCustomer.email && !m.subject.includes(String(created.number)),
    );
    expect(welcome).toBeDefined();
    const [message] = welcome!;
    for (const part of [message.subject, message.html, message.text]) expect(part).not.toMatch(/חנות|מוכר/);
    expect(message.text).toContain('SMS');

    // A second paid store order of the same account: no second welcome.
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const second = (await placeStore(sellerA)).body as StoreOrderCreated;
    await complete(txOf(second.redirectUrl), 'success').expect(200);
    expect((await orderOf(second.number)).status).toBe(OrderStatus.PAID);
    expect(await prisma.outboxJob.count({ where: { type: 'email.store_welcome' } })).toBe(1);
  });

  it("a quick account's store order asks for consent by SMS even from a later cart; a released e-mail gets no welcome", async () => {
    // The quick account is opened in one sale, whose basket is then dropped for a new one (another cart).
    await newSale(sellerA, [[plenty, 1]]);
    const customer = await quickAccount(sellerA);
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const first = await placeStore(sellerA, { marketingConsent: true });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const email = customer.newCustomer.email;
    expect(await prisma.marketingContact.findUnique({ where: { email } })).toMatchObject({
      status: MarketingStatus.PENDING,
      source: MarketingConsentSource.STORE,
    });

    // Paid; then a verified website sign-up takes the e-mail (released): the welcome is skipped, never sent to the
    // order's copy of the old address.
    await complete(txOf((first.body as StoreOrderCreated).redirectUrl), 'success').expect(200);
    await prisma.customer.update({ where: { id: customer.id }, data: { email: null } });
    emailSpy.mockClear();
    await outbox.runDue(100);
    // Only the order's own e-mail (its subject carries the number), no welcome.
    const sent = emailSpy.mock.calls.filter(([m]) => m.to === customer.newCustomer.email);
    expect(sent).toHaveLength(1);
    expect(sent[0][0].subject).toContain(String((first.body as StoreOrderCreated).number));
    expect(await prisma.outboxJob.findFirstOrThrow({ where: { type: 'email.store_welcome' } })).toMatchObject({
      state: 'DONE',
    });

    // Withdrawn, then the box ticked at a later sale: a new SMS request, never a recorded consent by itself.
    await prisma.customer.update({ where: { id: customer.id }, data: { email } });
    await prisma.$transaction((tx) => app.get(MarketingService).withdraw(tx, { email, source: 'account', actor: {} }));
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    expect((await placeStore(sellerA, { marketingConsent: true })).status).toBe(201);
    const contact = await prisma.marketingContact.findUniqueOrThrow({
      where: { email },
      include: { events: { orderBy: { id: 'asc' } } },
    });
    expect(contact.status).toBe(MarketingStatus.PENDING);
    expect(contact.events.map((e) => e.action)).toEqual([
      ConsentAction.REQUESTED,
      ConsentAction.WITHDRAWN,
      ConsentAction.REQUESTED,
    ]);
  });

  it('existing customer sale: the account is the customer, a known address is not saved twice, consent asked by SMS', async () => {
    const customer = await existingAccount();
    await prisma.customerAddress.create({ data: { customerId: customer.id, ...address, isDefault: true } });
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const res = await placeStore(sellerA, { marketingConsent: true });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = await orderOf((res.body as StoreOrderCreated).number);
    expect(order).toMatchObject({
      channel: OrderChannel.STORE,
      customerId: customer.id,
      contact: { fullName: 'ZZ דנה לוי', phone: customer.phone, email: customer.email },
      marketingConsent: true,
    });
    expect(await prisma.customerAddress.count({ where: { customerId: customer.id } })).toBe(1);
    // Any confirmed store customer with an e-mail gets the SMS link (decision 96); its verified e-mail links the contact.
    expect(await prisma.marketingContact.findUnique({ where: { email: customer.email! } })).toMatchObject({
      status: MarketingStatus.PENDING,
      source: MarketingConsentSource.STORE,
      customerId: customer.id,
    });
    expect(
      await prisma.outboxJob.findFirst({ where: { type: 'sms.store_consent' }, select: { payload: true } }),
    ).toMatchObject({ payload: { phone: customer.phone } });

    // saveAddress false: a new address stays on the order only.
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const other = { ...address, street: 'אלנבי' };
    const second = await placeStore(sellerA, { address: other, saveAddress: false });
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(await prisma.customerAddress.count({ where: { customerId: customer.id } })).toBe(1);
  });

  it('409 customer_not_confirmed without a customer, and after the confirmation lapsed', async () => {
    await newSale(sellerA, [[plenty, 1]]);
    const none = await sellerA.post('/store-orders', { ...orderBody(), expectedTotal: 1 }).expect(409);
    expect(none.body).toMatchObject({ code: 'customer_not_confirmed' });

    const customer = await existingAccount();
    await confirm(sellerA, customer.phone);
    await prisma.cart.updateMany({
      where: { sellerId: sellerAId },
      data: { storeConfirmedAt: new Date(Date.now() - 3 * HOUR_MS) },
    });
    const lapsed = await sellerA.post('/store-orders', { ...orderBody(), expectedTotal: 1 }).expect(409);
    expect(lapsed.body).toMatchObject({ code: 'customer_not_confirmed' });
    expect(await prisma.order.count({ where: { sellerId: sellerAId } })).toBe(0);
  });

  it('409 customer_email_required for an account without an e-mail', async () => {
    const customer = await existingAccount({ email: null });
    await newSale(sellerA, [[plenty, 1]]);
    await prisma.cart.updateMany({
      where: { sellerId: sellerAId },
      data: { storeCustomerId: customer.id, storeConfirmedAt: new Date() },
    });
    const res = await sellerA.post('/store-orders', { ...orderBody(), expectedTotal: 1 }).expect(409);
    expect(res.body).toMatchObject({ code: 'customer_email_required' });
  });

  it("a second sale cannot take a pending sale's stock; the pending sale can still be retried", async () => {
    const customer = await existingAccount();
    await newSale(sellerA, [[last, 1]]);
    await confirm(sellerA, customer.phone);
    const a = (await placeStore(sellerA)).body as StoreOrderCreated;
    expect(a.number).toEqual(expect.any(Number));

    // A new sale while A waits for its payment: A's cart and order stay, its unit stays reserved.
    await sellerA.post('/store-cart').expect(201);
    await sellerA.post('/store-cart/items', { variantId: last, quantity: 1 }).expect(409);
    // Even a line already in the cart (added before A's reservation) cannot be ordered.
    const cartB = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId, orders: { none: {} } } });
    await prisma.cartItem.create({ data: { cartId: cartB.id, variantId: last, quantity: 1, unitPriceAtAdd: 100_000 } });
    await confirm(sellerA, customer.phone);
    const b = await placeStore(sellerA);
    expect(b.status, JSON.stringify(b.body)).toBe(409);
    expect(b.body).toMatchObject({ code: 'insufficient_stock', variantId: last, available: 0 });
    expect((await orderOf(a.number)).status).toBe(OrderStatus.PENDING_PAYMENT);

    // A's payment fails; the retry from the pending list opens a new page and the payment goes through.
    await complete(txOf(a.redirectUrl), 'failure').expect(200);
    expect((await sellerA.get('/store-orders/pending').expect(200)).body).toEqual([
      expect.objectContaining({ number: a.number, status: 'payment_failed' }),
    ]);
    const retry = (await sellerA.post(`/store-orders/${a.number}/retry`).expect(201)).body as CheckoutResponse;
    expect(retry.redirectUrl).not.toBe(a.redirectUrl);
    expect((await complete(txOf(retry.redirectUrl), 'success').expect(200)).body).toEqual({
      confirmationUrl: '/pay/done',
    });
    expect((await orderOf(a.number)).status).toBe(OrderStatus.PAID);
    expect(await stockOf(last)).toBe(0);
  });

  it('double submit: a second POST for the same sale answers 409 order_pending, never a second order', async () => {
    const customer = await existingAccount();
    // The last unit: reopening the waiting order must not count its own reservation against it.
    await newSale(sellerA, [[last, 1]]);
    await confirm(sellerA, customer.phone);
    const probe = await sellerA.post('/store-orders', { ...orderBody(), expectedTotal: 0 }).expect(409);
    const body = { ...orderBody(), expectedTotal: probe.body.total as number };

    // Two at once: one order, the other sees it.
    const [x, y] = await Promise.all([sellerA.post('/store-orders', body), sellerA.post('/store-orders', body)]);
    const statuses = [x.status, y.status].sort((p, q) => p - q);
    expect(statuses, JSON.stringify([x.body, y.body])).toEqual([201, 409]);
    const won = (x.status === 201 ? x : y).body as StoreOrderCreated;
    expect((x.status === 409 ? x : y).body).toMatchObject({ code: 'order_pending', number: won.number });

    // And again later (the cart is no longer open).
    const again = await sellerA.post('/store-orders', body).expect(409);
    expect(again.body).toMatchObject({ code: 'order_pending', number: won.number });
    expect(await prisma.order.count({ where: { sellerId: sellerAId } })).toBe(1);
    expect((await orderOf(won.number)).status).toBe(OrderStatus.PENDING_PAYMENT);
    expect((await sellerA.get('/store-orders/pending').expect(200)).body).toEqual([
      expect.objectContaining({ number: won.number, status: 'pending_payment', actions: ['retry', 'cancel'] }),
    ]);

    // The provider tab was closed: the seller reopens the waiting order from the pending list. The old page's
    // payment is closed and a new page opens; the reservation starts again.
    const before = await orderOf(won.number);
    const reopened = (await sellerA.post(`/store-orders/${won.number}/retry`).expect(201)).body as CheckoutResponse;
    expect(reopened.redirectUrl).not.toBe(won.redirectUrl);
    const oldTx = txOf(won.redirectUrl);
    const newTx = txOf(reopened.redirectUrl);
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: oldTx } })).status).toBe('CANCELLED');
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: newTx } })).status).toBe('PENDING');
    const waiting = await orderOf(won.number);
    expect(waiting.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(waiting.reservedUntil.getTime()).toBeGreaterThanOrEqual(before.reservedUntil.getTime());

    // The new page pays the order, and returns to the store's short page.
    expect((await complete(newTx, 'success').expect(200)).body).toEqual({ confirmationUrl: '/pay/done' });
    expect((await orderOf(won.number)).status).toBe(OrderStatus.PAID);
    expect(await stockOf(last)).toBe(0);
    // The old page paid too, afterwards: the existing paid-twice rule (kept for staff, no stock, no status change).
    await complete(oldTx, 'success').expect(200);
    expect(await prisma.payment.findUniqueOrThrow({ where: { transactionId: oldTx } })).toMatchObject({
      status: 'SUCCEEDED',
      rawStatus: 'paid_twice',
    });
    expect((await orderOf(won.number)).status).toBe(OrderStatus.PAID);
    expect(await stockOf(last)).toBe(0);
    // A paid order is never reopened nor cancelled by the seller.
    expect((await sellerA.post(`/store-orders/${won.number}/retry`).expect(409)).body).toMatchObject({
      code: 'not_retryable',
    });
    await sellerA.post(`/store-orders/${won.number}/cancel`).expect(409);
    expect((await sellerA.get('/store-orders/pending').expect(200)).body).toEqual([]);

    // No open cart (its order is paid): the empty-cart error.
    expect((await sellerA.post('/store-orders', body).expect(409)).body).toMatchObject({ code: 'empty_cart' });
  });

  it('the old page paid first after a reopen: the order is paid once, the new page then is paid twice', async () => {
    const customer = await existingAccount();
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const a = (await placeStore(sellerA)).body as StoreOrderCreated;
    const reopened = (await sellerA.post(`/store-orders/${a.number}/retry`).expect(201)).body as CheckoutResponse;
    await complete(txOf(a.redirectUrl), 'success').expect(200);
    expect((await orderOf(a.number)).status).toBe(OrderStatus.PAID);
    expect(await stockOf(plenty)).toBe(49);
    await complete(txOf(reopened.redirectUrl), 'success').expect(200);
    expect(
      (await prisma.payment.findUniqueOrThrow({ where: { transactionId: txOf(reopened.redirectUrl) } })).rawStatus,
    ).toBe('paid_twice');
    expect(await stockOf(plenty)).toBe(49);
    // A failure of the closed old page never fails the reopened order's newer page.
    const b = await existingAccount();
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, b.phone);
    const c = (await placeStore(sellerA)).body as StoreOrderCreated;
    const again = (await sellerA.post(`/store-orders/${c.number}/retry`).expect(201)).body as CheckoutResponse;
    await complete(txOf(c.redirectUrl), 'failure').expect(200);
    expect((await orderOf(c.number)).status).toBe(OrderStatus.PENDING_PAYMENT);
    await complete(txOf(again.redirectUrl), 'success').expect(200);
    expect((await orderOf(c.number)).status).toBe(OrderStatus.PAID);
  });

  it('the seller cancels a failed store order; the customer retries a store order from the tokened page', async () => {
    const customer = await existingAccount();
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const a = (await placeStore(sellerA)).body as StoreOrderCreated;
    await complete(txOf(a.redirectUrl), 'failure').expect(200);
    expect((await sellerA.get('/store-orders/pending').expect(200)).body).toEqual([
      expect.objectContaining({ number: a.number, status: 'payment_failed', actions: ['retry', 'cancel'] }),
    ]);
    const cancelled = await sellerA.post(`/store-orders/${a.number}/cancel`).expect(200);
    expect(cancelled.body).toMatchObject({ number: a.number, status: 'cancelled' });
    const order = await prisma.order.findUniqueOrThrow({ where: { number: a.number }, include: { events: true } });
    expect(order.events).toEqual([
      expect.objectContaining({
        fromStatus: OrderStatus.PAYMENT_FAILED,
        toStatus: OrderStatus.CANCELLED,
        actorType: OrderActorType.ADMIN,
        actorAdminId: sellerAId,
      }),
    ]);
    // The customer's own cancel of a failed order is still refused (the website rule is unchanged).
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const b = (await placeStore(sellerA)).body as StoreOrderCreated;
    await complete(txOf(b.redirectUrl), 'failure').expect(200);
    const token = (await orderOf(b.number)).publicToken;
    const t = encodeURIComponent(token);
    await http().post(`/api/orders/${b.number}/cancel?t=${t}`).set('Origin', STOREFRONT).expect(409);

    // The customer retries the store order from the link in their e-mail: the provider returns to that tokened page.
    const retry = await http().post(`/api/orders/${b.number}/retry-payment?t=${t}`).set('Origin', STOREFRONT);
    expect(retry.status, JSON.stringify(retry.body)).toBe(201);
    const done = (await complete(txOf((retry.body as CheckoutResponse).redirectUrl), 'success').expect(200))
      .body as SandboxCompleteResponse;
    expect(done.confirmationUrl).toBe(`/order/${b.number}?t=${t}`);
    expect((await orderOf(b.number)).status).toBe(OrderStatus.PAID);
  });

  it('the store order costs what the website charges for the same cart; a quick account gets its welcome code', async () => {
    const welcome = await prisma.promotion.create({
      data: {
        name: 'ZZ הטבת הצטרפות',
        kind: PromotionKind.PERSONAL_TEMPLATE,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        validityDays: 30,
        isWelcome: true,
      },
    });
    await newSale(sellerA, [[plenty, 3]]);
    const customer = await quickAccount(sellerA);
    // The quick account gets its welcome code with the account, already on the sale's cart: nobody types it.
    const codes = await prisma.personalCode.findMany({ where: { customerId: customer.id } });
    expect(codes).toHaveLength(1);
    const [{ code }] = codes;
    expect(codes[0]).toMatchObject({ promotionId: welcome.id, issuedById: null });
    const view = (await sellerA.get('/store-cart').expect(200)).body as StoreCartView;
    expect(view.customer).toMatchObject({ id: customer.id, isNew: true });
    expect(view.couponCode).toBe(code);
    expect(view.subtotal).toBe(150_000);
    expect(view.discount).toEqual({ labelHe: 'ZZ הטבת הצטרפות', amount: 15_000, source: 'coupon', code });

    // The website, same lines, as a guest (no welcome benefit for a guest).
    const guest = request.agent(app.getHttpServer() as App);
    await guest.post('/api/cart/items').set('Origin', STOREFRONT).send({ variantId: plenty, quantity: 3 }).expect(200);
    const web = (await guest.get('/api/cart').expect(200)).body as CartView;
    const quote = (
      await guest
        .post('/api/shipping/quote')
        .set('Origin', STOREFRONT)
        .send({ localityId: LOCALITY, floor: address.floor, hasElevator: address.hasElevator })
        .expect(200)
    ).body as ShippingQuote;
    const shipping = quote.methods.find((m) => m.method === 'curbside')!.total;
    const { customer: attached, ...storeCart } = view;
    expect(attached).not.toBeNull();
    expect({ ...storeCart, discount: null, couponCode: null }).toEqual({ ...web, discount: null });

    // The total on the seller screen (view + quote) is the one the order takes.
    const expectedTotal = view.subtotal - view.discount!.amount + shipping;
    const res = await sellerA.post('/store-orders', { ...orderBody(), expectedTotal });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = await orderOf((res.body as StoreOrderCreated).number);
    expect(order).toMatchObject({ subtotal: 150_000, discount: 15_000, shippingTotal: shipping, total: expectedTotal });
    expect(order.promotionId).toBe(welcome.id);
    expect(order.personalCodeId).toBe((await prisma.personalCode.findUniqueOrThrow({ where: { code } })).id);

    // The website checkout of the same lines: the same subtotal and shipping, without the welcome code.
    const webRes = await guest
      .post('/api/checkout')
      .set('Origin', STOREFRONT)
      .send({
        ...orderBody(),
        contact: { fullName: 'ZZ אורח', phone: '0501234567', email: `guest${DOMAIN}` },
        expectedTotal: web.subtotal + shipping,
      });
    expect(webRes.status, JSON.stringify(webRes.body)).toBe(201);
    const webOrder = (
      await prisma.payment.findUniqueOrThrow({
        where: { transactionId: txOf((webRes.body as CheckoutResponse).redirectUrl) },
        include: { order: true },
      })
    ).order;
    expect(webOrder).toMatchObject({ subtotal: order.subtotal, shippingTotal: order.shippingTotal, discount: 0 });
    expect(webOrder.total - order.total).toBe(15_000);

    // The code also goes to the verified phone by SMS (the quick account's e-mail is not verified).
    expect(
      (await prisma.outboxJob.findMany({ where: { type: { contains: 'code' } } })).map((j) => [j.type, j.dedupeKey]),
    ).toEqual([['sms.welcome_code', `welcome_code:${codes[0].id}`]]);
    await outbox.runDue(100);
    expect(smsSpy.mock.calls.filter(([m]) => m.to === customer.phone && m.text.includes(code))).toHaveLength(1);
    expect(emailSpy.mock.calls.some(([m]) => m.text.includes(code))).toBe(false);
  });

  it('a welcome code only for a new account: an existing account confirmed at the store gets none', async () => {
    await prisma.promotion.create({
      data: {
        name: 'ZZ הטבת הצטרפות',
        kind: PromotionKind.PERSONAL_TEMPLATE,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        validityDays: 30,
        isWelcome: true,
      },
    });
    const existing = await existingAccount();
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, existing.phone);
    expect(await prisma.personalCode.count({ where: { customerId: existing.id } })).toBe(0);
    expect(((await sellerA.get('/store-cart').expect(200)).body as StoreCartView).couponCode).toBeNull();

    // A coupon the seller entered before the new customer was attached is kept; the welcome code waits in the account.
    await prisma.promotion.create({
      data: {
        name: 'ZZ קופון חנות',
        kind: PromotionKind.COUPON,
        code: 'ZZSTORE5',
        discountType: DiscountType.PERCENT,
        value: 5,
        target: PromotionTarget.ORDER,
      },
    });
    await newSale(sellerA, [[plenty, 1]]);
    await sellerA.post('/store-cart/coupon', { code: 'ZZSTORE5' }).expect(201);
    const customer = await quickAccount(sellerA);
    expect(await prisma.personalCode.count({ where: { customerId: customer.id } })).toBe(1);
    expect(((await sellerA.get('/store-cart').expect(200)).body as StoreCartView).couponCode).toBe('ZZSTORE5');
    // Clearing that customer keeps the seller's coupon.
    await sellerA.delete('/store-cart/customer').expect(200);
    expect(((await sellerA.get('/store-cart').expect(200)).body as StoreCartView).couponCode).toBe('ZZSTORE5');
  });

  it('clearing a quick account from the store cart drops its welcome code; the next new customer gets theirs', async () => {
    await prisma.promotion.create({
      data: {
        name: 'ZZ הטבת הצטרפות',
        kind: PromotionKind.PERSONAL_TEMPLATE,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        validityDays: 30,
        isWelcome: true,
      },
    });
    await newSale(sellerA, [[plenty, 1]]);
    const first = await quickAccount(sellerA);
    const firstCode = (await prisma.personalCode.findFirstOrThrow({ where: { customerId: first.id } })).code;
    expect(((await sellerA.get('/store-cart').expect(200)).body as StoreCartView).couponCode).toBe(firstCode);

    const cleared = (await sellerA.delete('/store-cart/customer').expect(200)).body as StoreCartView;
    expect(cleared.customer).toBeNull();
    expect(cleared.couponCode).toBeNull();
    // The code stays the account's own.
    expect(await prisma.personalCode.count({ where: { customerId: first.id } })).toBe(1);

    const second = await quickAccount(sellerA);
    const secondCode = (await prisma.personalCode.findFirstOrThrow({ where: { customerId: second.id } })).code;
    expect(((await sellerA.get('/store-cart').expect(200)).body as StoreCartView).couponCode).toBe(secondCode);
  });

  it('a website order still has channel web and the tokened confirmation path', async () => {
    const guest = request.agent(app.getHttpServer() as App);
    await guest.post('/api/cart/items').set('Origin', STOREFRONT).send({ variantId: plenty, quantity: 1 }).expect(200);
    const probe = await guest
      .post('/api/checkout')
      .set('Origin', STOREFRONT)
      .send({
        ...orderBody(),
        contact: { fullName: 'ZZ אורח', phone: '0501234567', email: `guest${DOMAIN}` },
        expectedTotal: 0,
      })
      .expect(409);
    const res = await guest
      .post('/api/checkout')
      .set('Origin', STOREFRONT)
      .send({
        ...orderBody(),
        contact: { fullName: 'ZZ אורח', phone: '0501234567', email: `guest${DOMAIN}` },
        expectedTotal: probe.body.total as number,
      })
      .expect(201);
    const tx = txOf((res.body as CheckoutResponse).redirectUrl);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: tx }, include: { order: true } });
    expect(payment.order).toMatchObject({ channel: OrderChannel.WEB, sellerId: null, storeId: null });
    const done = (await complete(tx, 'success').expect(200)).body as SandboxCompleteResponse;
    expect(done.confirmationUrl).toBe(
      `/order/${payment.order.number}?t=${encodeURIComponent(payment.order.publicToken)}`,
    );
    // A website order never sends the store welcome.
    expect(await prisma.outboxJob.count({ where: { type: 'email.store_welcome' } })).toBe(0);
  });

  it("seller B can neither see, retry nor cancel seller A's order; seller A cancels it", async () => {
    const customer = await existingAccount();
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const a = (await placeStore(sellerA)).body as StoreOrderCreated;

    await sellerB.get(`/store-orders/${a.number}`).expect(404);
    await sellerB.post(`/store-orders/${a.number}/retry`).expect(404);
    await sellerB.post(`/store-orders/${a.number}/cancel`).expect(404);
    expect((await sellerB.get('/store-orders/pending').expect(200)).body).toEqual([]);
    // A website order is no store order of anyone.
    await sellerA.get('/store-orders/100000').expect(404);

    const cancelled = await sellerA.post(`/store-orders/${a.number}/cancel`).expect(200);
    expect(cancelled.body as StoreOrderStatus).toMatchObject({ number: a.number, status: 'cancelled' });
    const order = await prisma.order.findUniqueOrThrow({ where: { number: a.number }, include: { events: true } });
    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect(order.events).toEqual([
      expect.objectContaining({
        toStatus: OrderStatus.CANCELLED,
        actorType: OrderActorType.ADMIN,
        actorAdminId: sellerAId,
      }),
    ]);
    expect(
      await prisma.auditLog.findFirst({ where: { action: 'store_order.cancel', entityId: String(a.number) } }),
    ).toMatchObject({ actorId: sellerAId });
    expect((await sellerA.get('/store-orders/pending').expect(200)).body).toEqual([]);
    // Cancelled: no retry, no second cancel.
    await sellerA.post(`/store-orders/${a.number}/retry`).expect(409);
    await sellerA.post(`/store-orders/${a.number}/cancel`).expect(409);
  });

  it('the database refuses a store order without its seller (orders_store_channel_check)', async () => {
    const customer = await existingAccount();
    await newSale(sellerA, [[plenty, 1]]);
    await confirm(sellerA, customer.phone);
    const a = (await placeStore(sellerA)).body as StoreOrderCreated;
    await expect(prisma.$executeRaw`UPDATE orders SET seller_id = NULL WHERE number = ${a.number}`).rejects.toThrow(
      /orders_store_channel_check/,
    );
    const web = await prisma.order.create({
      data: {
        publicToken: `zz-${unique()}`,
        contact: { fullName: 'ZZ אורח', phone: '0501234567', email: `guest${DOMAIN}` },
        address: {},
        method: 'CURBSIDE',
        shippingTotal: 0,
        shippingLines: [],
        subtotal: 0,
        total: 0,
        deliveryEstimate: {},
        paymentProvider: 'sandbox',
        shippingProvider: 'manual',
        reservedUntil: new Date(),
      },
    });
    await expect(
      prisma.$executeRaw`UPDATE orders SET channel = 'store', store_id = ${storeId} WHERE id = ${web.id}::uuid`,
    ).rejects.toThrow(/orders_store_channel_check/);
    await expect(
      prisma.$executeRaw`INSERT INTO orders (id, public_token, contact, address, method, shipping_total, shipping_lines,
        subtotal, total, delivery_estimate, payment_provider, shipping_provider, reserved_until, channel, store_id,
        updated_at)
        VALUES (gen_random_uuid(), ${`zz-${unique()}`}, '{"fullName":"ZZ"}', '{}', 'curbside', 0, '[]', 0, 0, '{}',
        'sandbox', 'manual', now(), 'store', ${storeId}, now())`,
    ).rejects.toThrow(/orders_store_channel_check/);
  });

  it("quotes the seller's open cart like the website quotes the same lines; never another seller's cart", async () => {
    const quoteBody = { localityId: LOCALITY, floor: address.floor, hasElevator: address.hasElevator };
    // No open cart: the storefront's empty-cart answer; a bad body: the storefront's 400.
    expect((await sellerB.post('/store-cart/shipping-quote', quoteBody).expect(409)).body).toMatchObject({
      code: 'empty_cart',
    });
    await sellerA.post('/store-cart/shipping-quote', { ...quoteBody, floor: -1 }).expect(400);

    await newSale(sellerA, [
      [plenty, 2],
      [last, 1],
    ]);
    const store = (await sellerA.post('/store-cart/shipping-quote', quoteBody).expect(200)).body as ShippingQuote;
    const guest = request.agent(app.getHttpServer() as App);
    await guest.post('/api/cart/items').set('Origin', STOREFRONT).send({ variantId: plenty, quantity: 2 }).expect(200);
    await guest.post('/api/cart/items').set('Origin', STOREFRONT).send({ variantId: last, quantity: 1 }).expect(200);
    const web = (await guest.post('/api/shipping/quote').set('Origin', STOREFRONT).send(quoteBody).expect(200))
      .body as ShippingQuote;
    expect(store).toEqual(web);
    expect(store.methods.length).toBeGreaterThan(0);

    // Seller B's (empty) cart is quoted, never seller A's lines.
    await sellerB.post('/store-cart').expect(201);
    expect((await sellerB.post('/store-cart/shipping-quote', quoteBody).expect(409)).body).toMatchObject({
      code: 'empty_cart',
    });
  });

  it("returns the confirmed customer's saved addresses, default first; 409 once the confirmation lapsed", async () => {
    await newSale(sellerA, [[plenty, 1]]);
    expect((await sellerA.get('/store-cart/customer/addresses').expect(409)).body).toMatchObject({
      code: 'customer_not_confirmed',
    });
    const customer = await existingAccount();
    await prisma.customerAddress.create({ data: { customerId: customer.id, ...address, street: 'אלנבי' } });
    await prisma.customerAddress.create({ data: { customerId: customer.id, ...address, isDefault: true } });
    await confirm(sellerA, customer.phone);

    const res = await sellerA.get('/store-cart/customer/addresses').expect(200);
    expect(res.headers['set-cookie']).toBeUndefined();
    const list = res.body as CustomerAddressView[];
    expect(list.map((a) => [a.street, a.isDefault])).toEqual([
      ['הרצל', true],
      ['אלנבי', false],
    ]);
    // The account's own address view (GET /api/account/addresses).
    expect(list[0]).toMatchObject({ ...address, id: expect.any(String), isDefault: true });
    // Seller B has no confirmed customer: nothing of seller A's customer.
    await sellerB.get('/store-cart/customer/addresses').expect(409);

    await prisma.cart.updateMany({
      where: { sellerId: sellerAId },
      data: { storeConfirmedAt: new Date(Date.now() - 3 * HOUR_MS) },
    });
    expect((await sellerA.get('/store-cart/customer/addresses').expect(409)).body).toMatchObject({
      code: 'customer_not_confirmed',
    });
  });

  it('refuses the store-order endpoints without the orders.store permission', async () => {
    const anonymous = request.agent(app.getHttpServer() as App);
    await anonymous.post('/api/admin/store-orders').set('Origin', 'http://localhost:4300').send({}).expect(401);
    await anonymous.get('/api/admin/store-orders/pending').set('Origin', 'http://localhost:4300').expect(401);
    const created = await owner
      .post('/users', { email: 'viewer@example.test', name: 'צופה', template: 'content_editor' })
      .expect(201);
    const viewer = await acceptAndSignIn(
      app,
      { email: 'viewer@example.test', password: 'pebble garden lantern ocean' },
      created.body.invite as OneTimeLink,
    );
    await viewer.post('/store-orders', {}).expect(403);
    await viewer.get('/store-orders/pending').expect(403);
    await viewer.post('/store-orders/100001/retry').expect(403);
  });
});
