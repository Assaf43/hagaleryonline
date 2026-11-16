import type { AddressInfo } from 'node:net';
import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type {
  CartView,
  CheckoutRequest,
  CheckoutResponse,
  ShippingQuote,
  StoreCartView,
  StoreOrderCreated,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { hashPassword } from './../src/auth/passwords.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  DiscountType,
  OrderStatus,
  PromotionKind,
  PromotionTarget,
  type Prisma,
} from './../src/generated/prisma/client.js';
import { SMS_PROVIDER, type SmsProvider } from './../src/notifications/notification-provider.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteOrders } from './test-orders.js';
import { uniqueIds } from './unique-ids.js';

const ORIGIN = 'http://localhost:4200';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;
const DOMAIN = '@member-pricing.e2e.test';
const PASSWORD = 'correct horse 18';

// Phase 7b (CLB-03, CLB-05, decisions 91–92, 94): the cart, the website checkout and the store checkout price a
// member's cart twice (member prices / regular prices) and charge the lower total; a guest pays regular prices and
// sees what a member would save; members-only coupons need an account and work once per account.
describe('Member pricing (e2e, CLB-03, CLB-05, decisions 91–92, 94)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let seller: AdminBrowser;
  /** 5,000 ₪, member price 4,500 ₪. */
  let sofa: number;
  /** 1,000 ₪, no member price. */
  let table: number;

  const unique = uniqueIds(8);
  const http = () => request(app.getHttpServer() as App);

  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    return {
      agent,
      cart: async () => (await agent.get('/api/cart').expect(200)).body as CartView,
      add: (variantId: number, quantity: number) =>
        agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity }).expect(200),
      apply: (code: string) => agent.post('/api/cart/coupon').set('Origin', ORIGIN).send({ code }),
      signIn: (email: string) =>
        agent.post('/api/account/sign-in').set('Origin', ORIGIN).send({ email, password: PASSWORD }).expect(200),
      /** The total the storefront shows: subtotal − discount + the curbside quote. */
      expectedTotal: async () => {
        const view = (await agent.get('/api/cart').expect(200)).body as CartView;
        const quote = (
          await agent
            .post('/api/shipping/quote')
            .set('Origin', ORIGIN)
            .send({ localityId: LOCALITY, floor: 0, hasElevator: true })
            .expect(200)
        ).body as ShippingQuote;
        return view.subtotal - (view.discount?.amount ?? 0) + quote.methods.find((m) => m.method === 'curbside')!.total;
      },
      checkout: (expectedTotal: number) =>
        agent
          .post('/api/checkout')
          .set('Origin', ORIGIN)
          .send({ ...checkoutBody(), expectedTotal }),
    };
  };
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
  const txOf = (redirectUrl: string) => /\/pay\/sandbox\/([\w-]+)$/.exec(redirectUrl)![1];
  const pay = (tx: string) =>
    http()
      .post(`/api/payments/sandbox/${tx}/complete`)
      .set('Origin', ORIGIN)
      .send({ outcome: 'success', installments: 1 })
      .expect(200);
  const orderOfTx = async (transactionId: string) =>
    (
      await prisma.payment.findUniqueOrThrow({
        where: { transactionId },
        include: { order: { include: { items: { orderBy: { id: 'asc' } } } } },
      })
    ).order;

  const account = async () => {
    const id = unique();
    const email = `user${id}${DOMAIN}`;
    const customer = await prisma.customer.create({
      data: {
        fullName: 'ZZ דנה לוי',
        phone: `05${id}`,
        email,
        passwordHash: await hashPassword(PASSWORD),
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });
    return customer;
  };
  const member = async () => {
    const customer = await account();
    const b = browser();
    await b.signIn(customer.email!);
    return { customer, b };
  };
  const promotion = (data: Partial<Prisma.PromotionUncheckedCreateInput> = {}) =>
    prisma.promotion.create({
      data: {
        name: 'ZZ מבצע',
        kind: PromotionKind.AUTOMATIC,
        discountType: DiscountType.PERCENT,
        value: 20,
        target: PromotionTarget.ORDER,
        ...data,
      },
    });
  const smsCode = (to: string) => {
    const call = smsSpy.mock.calls.filter(([m]) => m.to === to).at(-1);
    return /(\d{6})/.exec(call![0].text)![1];
  };
  /** The parts of a cart view that carry money. */
  const money = (v: CartView) => ({
    pricing: v.pricing,
    subtotal: v.subtotal,
    discount: v.discount,
    memberSavings: v.memberSavings,
    lines: v.lines.map((l) => ({
      variantId: l.variantId,
      unitPrice: l.unitPrice,
      memberPrice: l.memberPrice,
      atMemberPrice: l.atMemberPrice,
      quantity: l.quantity,
      lineTotal: l.lineTotal,
    })),
  });

  const cleanData = async () => {
    await deleteOrders(prisma, { OR: [{ contact: { path: ['fullName'], string_starts_with: 'ZZ' } }] });
    await prisma.cart.deleteMany();
    await prisma.otpCode.deleteMany({});
    await prisma.promotion.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
    await prisma.customer.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    // resetAdminData TRUNCATEs admin_users CASCADE (orders, carts, customers go too): every fixture comes after it.
    await resetAdminData(prisma);
    await cleanData();
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-mbr' } } });
    seller = (await signInOwnerAnd(app, 'store_seller')).other;

    const category = await prisma.category.create({
      data: {
        slug: 'zz-mbr',
        nameHe: 'בדיקת מחירי מועדון',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const size = { widthCm: 200, depthCm: 90, heightCm: 80, leadTimeDays: 7 };
    const product = await prisma.product.create({
      data: {
        slug: 'zz-mbr-sofa',
        modelName: 'ZZMBR',
        nameHe: 'ספת מועדון',
        categoryId: category.id,
        variants: {
          create: [
            { sku: 'ZZMBR-SOFA', price: 500_000, memberPrice: 450_000, stock: 100, sortOrder: 0, ...size },
            { sku: 'ZZMBR-TABLE', price: 100_000, stock: 100, sortOrder: 1, ...size, widthCm: 120 },
          ],
        },
      },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    [sofa, table] = product.variants.map((v) => v.id);
    await app.get(CacheStore).invalidate('catalog:');
  });

  beforeEach(() => {
    const throttle = app.get(WriteThrottle);
    throttle.setLimit('store_otp', 100);
    throttle.setLimit('store_lookup', 100);
    throttle.setLimit('store_verify', 100);
  });

  afterEach(cleanData);

  afterAll(async () => {
    await cleanData();
    await resetAdminData(prisma);
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-mbr' } } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  it('a guest cart has regular prices and a hint of what a member would save', async () => {
    const b = browser();
    await b.add(sofa, 1);
    await b.add(table, 1);
    expect(money(await b.cart())).toEqual({
      pricing: 'regular',
      subtotal: 600_000,
      discount: null,
      memberSavings: 50_000,
      lines: [
        {
          variantId: sofa,
          unitPrice: 500_000,
          memberPrice: 450_000,
          atMemberPrice: false,
          quantity: 1,
          lineTotal: 500_000,
        },
        {
          variantId: table,
          unitPrice: 100_000,
          memberPrice: null,
          atMemberPrice: false,
          quantity: 1,
          lineTotal: 100_000,
        },
      ],
    });

    // 20% sitewide that does not apply to member prices: a member would pay what the guest pays → no hint.
    await promotion();
    const view = await b.cart();
    expect(view.subtotal - view.discount!.amount).toBe(480_000);
    expect(view.memberSavings).toBeNull();
  });

  it('a signed-in cart has member prices', async () => {
    const { b } = await member();
    await b.add(sofa, 2);
    await b.add(table, 1);
    expect(money(await b.cart())).toEqual({
      pricing: 'member',
      subtotal: 1_000_000,
      discount: null,
      memberSavings: null,
      lines: [
        {
          variantId: sofa,
          unitPrice: 450_000,
          memberPrice: 450_000,
          atMemberPrice: true,
          quantity: 2,
          lineTotal: 900_000,
        },
        {
          variantId: table,
          unitPrice: 100_000,
          memberPrice: null,
          atMemberPrice: false,
          quantity: 1,
          lineTotal: 100_000,
        },
      ],
    });
  });

  it('best of two: 20% with the switch off → regular pricing (4,000 ₪); with the switch on → member (3,600 ₪)', async () => {
    const promo = await promotion();
    const { b } = await member();
    await b.add(sofa, 1);
    const off = await b.cart();
    expect(money(off)).toMatchObject({ pricing: 'regular', subtotal: 500_000, memberSavings: null });
    expect(off.lines[0]).toMatchObject({ unitPrice: 500_000, atMemberPrice: false });
    expect(off.discount?.amount).toBe(100_000);

    await prisma.promotion.update({ where: { id: promo.id }, data: { appliesToMemberPrices: true } });
    const on = await b.cart();
    expect(money(on)).toMatchObject({ pricing: 'member', subtotal: 450_000 });
    expect(on.lines[0]).toMatchObject({ unitPrice: 450_000, atMemberPrice: true });
    expect(on.discount?.amount).toBe(90_000);

    // Checkout charges the same: 3,600 ₪ + shipping, member pricing on the order and the line.
    const total = await b.expectedTotal();
    const res = await b.checkout(total);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = await orderOfTx(txOf((res.body as CheckoutResponse).redirectUrl));
    expect(order).toMatchObject({ pricing: 'member', subtotal: 450_000, discount: 90_000, total });
    expect(order.items).toMatchObject([{ unitPrice: 450_000, quantity: 1, lineTotal: 450_000, atMemberPrice: true }]);
  });

  it('the regular run wins at checkout too: the order stores regular pricing', async () => {
    await promotion();
    const { b } = await member();
    await b.add(sofa, 1);
    const total = await b.expectedTotal();
    const res = await b.checkout(total);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = await orderOfTx(txOf((res.body as CheckoutResponse).redirectUrl));
    expect(order).toMatchObject({ pricing: 'regular', subtotal: 500_000, discount: 100_000, total });
    expect(order.items).toMatchObject([{ unitPrice: 500_000, lineTotal: 500_000, atMemberPrice: false }]);
  });

  it('sign-in mid-checkout reprices: the guest total is refused, the member total is charged', async () => {
    const customer = await account();
    const b = browser();
    await b.add(sofa, 1);
    await b.add(table, 2);
    const guestTotal = await b.expectedTotal();
    await b.signIn(customer.email!);
    const memberTotal = await b.expectedTotal();
    expect(guestTotal - memberTotal).toBe(50_000);

    const refused = await b.checkout(guestTotal).expect(409);
    expect(refused.body).toEqual({ statusCode: 409, code: 'price_changed', total: memberTotal });
    expect(await prisma.order.count({ where: { customerId: customer.id } })).toBe(0);

    const res = await b.checkout(memberTotal);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const tx = txOf((res.body as CheckoutResponse).redirectUrl);
    await pay(tx);
    const order = await orderOfTx(tx);
    expect(order).toMatchObject({
      status: OrderStatus.PAID,
      customerId: customer.id,
      pricing: 'member',
      subtotal: 650_000,
      discount: 0,
      total: memberTotal,
    });
    expect(order.items).toMatchObject([
      { variantId: sofa, unitPrice: 450_000, quantity: 1, lineTotal: 450_000, atMemberPrice: true },
      { variantId: table, unitPrice: 100_000, quantity: 2, lineTotal: 200_000, atMemberPrice: false },
    ]);
  });

  it('a store sale for a confirmed customer is priced like the website member cart', async () => {
    await promotion({ value: 5 });
    const customer = await account();
    const web = browser();
    await web.signIn(customer.email!);
    await web.add(sofa, 2);
    await web.add(table, 1);
    const website = money(await web.cart());
    expect(website).toMatchObject({ pricing: 'member', subtotal: 1_000_000 });

    await seller.post('/store-cart').expect(201);
    await seller.post('/store-cart/items', { variantId: sofa, quantity: 2 }).expect(201);
    const unconfirmed = (await seller.post('/store-cart/items', { variantId: table, quantity: 1 }).expect(201))
      .body as StoreCartView;
    // No confirmed customer yet: regular prices, like a guest.
    expect(unconfirmed).toMatchObject({ pricing: 'regular', subtotal: 1_100_000 });

    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    const confirmed = (
      await seller
        .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code: smsCode(customer.phone) })
        .expect(200)
    ).body as StoreCartView;
    expect(money(confirmed)).toEqual(website);

    const address = { ...checkoutBody().address };
    const body = { address, method: 'curbside', acceptTerms: true };
    const probe = await seller.post('/store-orders', { ...body, expectedTotal: 0 }).expect(409);
    expect(probe.body).toMatchObject({ code: 'price_changed' });
    const res = await seller.post('/store-orders', { ...body, expectedTotal: probe.body.total as number });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const order = await prisma.order.findUniqueOrThrow({
      where: { number: (res.body as StoreOrderCreated).number },
      include: { items: { orderBy: { id: 'asc' } } },
    });
    expect(order).toMatchObject({
      customerId: customer.id,
      pricing: 'member',
      subtotal: website.subtotal,
      discount: website.discount?.amount ?? 0,
    });
    expect(order.items.map((i) => [i.variantId, i.unitPrice, i.lineTotal, i.atMemberPrice])).toEqual([
      [sofa, 450_000, 900_000, true],
      [table, 100_000, 100_000, false],
    ]);
  });

  it('a members-only coupon: a guest gets members_only, a member uses it once, then exhausted', async () => {
    await promotion({
      name: 'ZZ קופון חברים',
      kind: PromotionKind.COUPON,
      code: 'ZZMEMBERS',
      value: 10,
      membersOnly: true,
    });
    const guest = browser();
    await guest.add(table, 1);
    expect((await guest.apply('zzmembers').expect(400)).body).toMatchObject({
      code: 'invalid_coupon',
      messageHe: 'הקופון מיועד לחברי מועדון בלבד. התחברו כדי להשתמש בו',
    });

    const { customer, b } = await member();
    await b.add(table, 1);
    const applied = (await b.apply('zzmembers').expect(200)).body as CartView;
    expect(applied.discount).toMatchObject({ amount: 10_000, code: 'ZZMEMBERS' });
    const res = await b.checkout(await b.expectedTotal());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    await pay(txOf((res.body as CheckoutResponse).redirectUrl));
    expect(await prisma.order.count({ where: { customerId: customer.id, status: OrderStatus.PAID } })).toBe(1);

    await b.add(table, 1);
    expect((await b.apply('ZZMEMBERS').expect(400)).body).toMatchObject({ messageHe: 'הקופון נוצל במלואו' });

    // Another account may still use it.
    const other = await member();
    await other.b.add(table, 1);
    await other.b.apply('ZZMEMBERS').expect(200);
  });

  it('a members-only coupon is held by a live pending order of the account', async () => {
    await promotion({
      name: 'ZZ קופון חברים',
      kind: PromotionKind.COUPON,
      code: 'ZZMEMBERS',
      value: 10,
      membersOnly: true,
    });
    const { customer, b } = await member();
    await b.add(table, 1);
    await b.apply('ZZMEMBERS').expect(200);
    const res = await b.checkout(await b.expectedTotal());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    // A second checkout of the same cart replaces its own pending order: still allowed.
    const again = await b.checkout(await b.expectedTotal());
    expect(again.status, JSON.stringify(again.body)).toBe(201);
    // A pending order of another cart of the account holds it.
    await prisma.order.updateMany({ where: { customerId: customer.id }, data: { cartId: null } });
    const view = await b.cart();
    expect(view.couponCode).toBeNull();
    expect(view.discount).toBeNull();
    expect(view.notices).toContainEqual(expect.objectContaining({ kind: 'coupon', messageHe: 'הקופון נוצל במלואו' }));
  });

  it('a members-only coupon works for the confirmed store customer only', async () => {
    await promotion({
      name: 'ZZ קופון חברים',
      kind: PromotionKind.COUPON,
      code: 'ZZMEMBERS',
      value: 10,
      membersOnly: true,
    });
    const customer = await account();
    await seller.post('/store-cart').expect(201);
    await seller.post('/store-cart/items', { variantId: table, quantity: 1 }).expect(201);
    expect((await seller.post('/store-cart/coupon', { code: 'ZZMEMBERS' }).expect(400)).body).toMatchObject({
      messageHe: 'הקופון מיועד לחברי מועדון בלבד. התחברו כדי להשתמש בו',
    });
    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    await seller
      .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code: smsCode(customer.phone) })
      .expect(200);
    const view = (await seller.post('/store-cart/coupon', { code: 'ZZMEMBERS' }).expect(201)).body as StoreCartView;
    expect(view.discount).toMatchObject({ amount: 10_000, code: 'ZZMEMBERS' });
  });

  it('a payment retry cannot use a members-only coupon a second time (decision 94)', async () => {
    await promotion({
      name: 'ZZ קופון חברים',
      kind: PromotionKind.COUPON,
      code: 'ZZMEMBERS',
      value: 10,
      membersOnly: true,
    });
    const { customer, b } = await member();

    // A store order holds the coupon, and its payment fails.
    await seller.post('/store-cart').expect(201);
    await seller.post('/store-cart/items', { variantId: table, quantity: 1 }).expect(201);
    await seller.post('/store-cart/customer/code', { phone: customer.phone, channel: 'sms' }).expect(204);
    await seller
      .post('/store-cart/customer/verify', { phone: customer.phone, channel: 'sms', code: smsCode(customer.phone) })
      .expect(200);
    await seller.post('/store-cart/coupon', { code: 'ZZMEMBERS' }).expect(201);
    const body = { address: { ...checkoutBody().address }, method: 'curbside', acceptTerms: true };
    const probe = await seller.post('/store-orders', { ...body, expectedTotal: 0 }).expect(409);
    const store = await seller.post('/store-orders', { ...body, expectedTotal: probe.body.total as number });
    expect(store.status, JSON.stringify(store.body)).toBe(201);
    const storeOrder = store.body as StoreOrderCreated;
    await http()
      .post(`/api/payments/sandbox/${txOf(storeOrder.redirectUrl)}/complete`)
      .set('Origin', ORIGIN)
      .send({ outcome: 'failure', installments: 1 })
      .expect(200);

    // The failed order no longer holds it: the same account pays a website order with the coupon.
    await b.add(table, 1);
    await b.apply('ZZMEMBERS').expect(200);
    const web = await b.checkout(await b.expectedTotal());
    expect(web.status, JSON.stringify(web.body)).toBe(201);
    await pay(txOf((web.body as CheckoutResponse).redirectUrl));

    // The seller's retry of the store order would be a second use: refused like an ended promotion.
    const retry = await seller.post(`/store-orders/${storeOrder.number}/retry`).expect(409);
    expect(retry.body).toMatchObject({ code: 'promotion_ended' });
    const order = await prisma.order.findUniqueOrThrow({ where: { number: storeOrder.number } });
    expect(order.status).toBe(OrderStatus.PAYMENT_FAILED);
  });
});
