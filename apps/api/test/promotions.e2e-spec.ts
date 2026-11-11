import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { CartView, CheckoutRequest, CheckoutResponse, OrderView, ShippingQuote } from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  DiscountType,
  OrderStatus,
  PromotionKind,
  PromotionTarget,
  type Prisma,
} from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ORIGIN = 'http://localhost:4200';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;
const DAY = 24 * 60 * 60_000;

// Runs against the e2e test database (test/e2e-global-setup.ts). The API listens on an ephemeral port so the
// sandbox "complete" endpoint can deliver its signed webhook over HTTP (as in checkout.e2e-spec.ts).
describe('Promotions and coupons (e2e, CRT-03, ADM-05, spec §6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  /** In the sub-category zz-promo-sub (under zz-promo): 100,000 a unit. */
  let sofa: number;
  let sofaProductId: number;
  /** In zz-promo-other: 50,000 a unit. */
  let lamp: number;
  let parentCategoryId: number;
  let savedSettings: { additionalItemPercent: number; floorSurcharge: number; floorSurchargeFrom: number } | null;

  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    return {
      agent,
      cart: async () => (await agent.get('/api/cart').expect(200)).body as CartView,
      add: (variantId: number, quantity: number) =>
        agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity }).expect(200),
      remove: (variantId: number) => agent.delete(`/api/cart/items/${variantId}`).set('Origin', ORIGIN).expect(200),
      apply: (code: unknown) => agent.post('/api/cart/coupon').set('Origin', ORIGIN).send({ code }),
      unapply: () => agent.delete('/api/cart/coupon').set('Origin', ORIGIN),
      /** The total the storefront shows: subtotal − discount + the curbside quote. */
      expectedTotal: async () => {
        const [cart, quote] = await Promise.all([
          agent.get('/api/cart').expect(200),
          agent
            .post('/api/shipping/quote')
            .set('Origin', ORIGIN)
            .send({ localityId: LOCALITY, floor: 0, hasElevator: true })
            .expect(200),
        ]);
        const view = cart.body as CartView;
        const option = (quote.body as ShippingQuote).methods.find((m) => m.method === 'curbside')!;
        return view.subtotal - (view.discount?.amount ?? 0) + option.total;
      },
      checkout: async (expectedTotal?: number) =>
        agent
          .post('/api/checkout')
          .set('Origin', ORIGIN)
          .send({ ...checkoutBody(), expectedTotal: expectedTotal ?? (await browserTotal(agent)) }),
    };
  };
  const browserTotal = async (agent: ReturnType<typeof request.agent>) => {
    const view = (await agent.get('/api/cart').expect(200)).body as CartView;
    const quote = (
      await agent
        .post('/api/shipping/quote')
        .set('Origin', ORIGIN)
        .send({ localityId: LOCALITY, floor: 0, hasElevator: true })
        .expect(200)
    ).body as ShippingQuote;
    return view.subtotal - (view.discount?.amount ?? 0) + quote.methods.find((m) => m.method === 'curbside')!.total;
  };
  const checkoutBody = (): Omit<CheckoutRequest, 'expectedTotal'> => ({
    contact: { fullName: 'דנה כהן', phone: '050-1234567', email: 'dana@example.test' },
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
  const http = () => request(app.getHttpServer() as App);
  const txOf = (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { redirectUrl } = res.body as CheckoutResponse;
    return /\/pay\/sandbox\/([\w-]+)$/.exec(redirectUrl)![1];
  };
  const orderOfTx = async (transactionId: string) =>
    (await prisma.payment.findUniqueOrThrow({ where: { transactionId }, include: { order: true } })).order;
  const pay = (tx: string) =>
    http()
      .post(`/api/payments/sandbox/${tx}/complete`)
      .set('Origin', ORIGIN)
      .send({ outcome: 'success', installments: 1 });
  const promotion = (data: Partial<Prisma.PromotionUncheckedCreateInput> = {}) =>
    prisma.promotion.create({
      data: {
        name: 'קופון בדיקה',
        kind: PromotionKind.COUPON,
        code: 'SAVE10',
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        ...data,
      },
    });
  const usedCount = async (id: number) => (await prisma.promotion.findUniqueOrThrow({ where: { id } })).usedCount;
  const invalidateCatalog = () => app.get(CacheStore).invalidate('catalog:');

  const cleanup = async () => {
    await prisma.order.deleteMany();
    await prisma.cart.deleteMany();
    await prisma.promotion.deleteMany();
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZPROMO' } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-promo-' } } });
    await prisma.category.deleteMany({ where: { slug: 'zz-promo' } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    await cleanup();

    const rate = { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } };
    const parent = await prisma.category.create({
      data: { slug: 'zz-promo', nameHe: 'בדיקת מבצעים', shippingRate: rate },
    });
    parentCategoryId = parent.id;
    const sub = await prisma.category.create({
      data: { slug: 'zz-promo-sub', nameHe: 'תת קטגוריה', parentId: parent.id },
    });
    const other = await prisma.category.create({
      data: { slug: 'zz-promo-other', nameHe: 'אחרת', shippingRate: rate },
    });
    const size = { widthCm: 200, depthCm: 90, heightCm: 80, leadTimeDays: 7 };
    const sofaProduct = await prisma.product.create({
      data: {
        slug: 'zz-promo-sofa',
        modelName: 'ZZPROMO',
        nameHe: 'ספת מבצע',
        categoryId: sub.id,
        variants: { create: [{ sku: 'ZZPROMO-1', price: 100_000, stock: 100, sortOrder: 0, ...size }] },
      },
      include: { variants: true },
    });
    sofaProductId = sofaProduct.id;
    sofa = sofaProduct.variants[0].id;
    const lampProduct = await prisma.product.create({
      data: {
        slug: 'zz-promo-lamp',
        modelName: 'ZZPROMOLAMP',
        nameHe: 'מנורת מבצע',
        categoryId: other.id,
        variants: { create: [{ sku: 'ZZPROMO-L', price: 50_000, stock: 100, sortOrder: 0, ...size }] },
      },
      include: { variants: true },
    });
    lamp = lampProduct.variants[0].id;

    savedSettings = await prisma.shippingSettings.findUnique({ where: { id: 1 } });
    const settings = { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 };
    await prisma.shippingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
    await invalidateCatalog();
  });

  afterAll(async () => {
    await cleanup();
    if (savedSettings) await prisma.shippingSettings.update({ where: { id: 1 }, data: savedSettings });
    else await prisma.shippingSettings.deleteMany();
    await invalidateCatalog();
    await app.close();
  });

  afterEach(async () => {
    await prisma.order.deleteMany();
    await prisma.cart.deleteMany();
    await prisma.promotion.deleteMany();
  });

  it('applies a coupon to the cart (case-insensitive) and removes it', async () => {
    await promotion();
    const b = browser();
    await b.add(sofa, 2);
    const res = await b.apply('  save10 ').expect(200);
    const view = res.body as CartView;
    expect(view.couponCode).toBe('SAVE10');
    expect(view.discount).toEqual({ labelHe: 'קופון בדיקה', amount: 20_000, source: 'coupon', code: 'SAVE10' });
    expect(view.notices).toEqual([]);
    expect((await b.cart()).discount?.amount).toBe(20_000);

    const removed = (await b.unapply().expect(200)).body as CartView;
    expect(removed.couponCode).toBeNull();
    expect(removed.discount).toBeNull();
    expect((await b.cart()).couponCode).toBeNull();
  });

  it('the coupon endpoints need the storefront origin and a code', async () => {
    await promotion();
    const b = browser();
    await b.add(sofa, 1);
    await b.agent.post('/api/cart/coupon').send({ code: 'SAVE10' }).expect(403);
    await b.agent.delete('/api/cart/coupon').expect(403);
    expect((await b.apply(42).expect(400)).body).toMatchObject({ code: 'invalid_input' });
    expect((await b.apply('x'.repeat(65)).expect(400)).body).toMatchObject({ code: 'invalid_input' });
    // No cart: nothing to apply it to, and no cart is created.
    const fresh = browser();
    const none = await fresh.apply('SAVE10').expect(400);
    expect(none.body).toMatchObject({ code: 'invalid_coupon', messageHe: 'הקופון לא חל על המוצרים בסל' });
    expect(none.headers['set-cookie']).toBeUndefined();
  });

  it('refuses each invalid coupon with its Hebrew message and keeps the cart unchanged', async () => {
    const now = Date.now();
    await promotion({ code: 'OLD', endsAt: new Date(now - DAY) });
    await promotion({ code: 'SOON', startsAt: new Date(now + DAY) });
    await promotion({ code: 'OFF', active: false });
    await promotion({ code: 'BIG', minSubtotal: 500_000 });
    await promotion({ code: 'USED', usageLimit: 2, usedCount: 2 });
    await promotion({ code: 'LAMPS', target: PromotionTarget.PRODUCTS, targetIds: [-1] });
    await promotion({ name: 'מבצע אוטומטי', kind: PromotionKind.AUTOMATIC, code: null, value: 5 });
    const b = browser();
    await b.add(sofa, 1);
    const cases: [string, string][] = [
      ['NOPE', 'קוד הקופון לא קיים'],
      ['OLD', 'תוקף הקופון פג'],
      ['SOON', 'תוקף הקופון פג'],
      ['OFF', 'תוקף הקופון פג'],
      ['BIG', 'הקופון תקף מסכום של 5,000 ₪'],
      ['USED', 'הקופון נוצל במלואו'],
      ['LAMPS', 'הקופון לא חל על המוצרים בסל'],
    ];
    for (const [code, messageHe] of cases) {
      const res = await b.apply(code).expect(400);
      expect(res.body, code).toEqual({ statusCode: 400, code: 'invalid_coupon', field: 'coupon', messageHe });
    }
    // The automatic promotion's code space is not a coupon.
    const view = await b.cart();
    expect(view.couponCode).toBeNull();
    expect(view.discount).toMatchObject({ source: 'automatic', amount: 5_000 });
  });

  it('an automatic promotion on a parent category applies to a product of its sub-category', async () => {
    await promotion({
      name: 'ספות ב־20%',
      kind: PromotionKind.AUTOMATIC,
      code: null,
      value: 20,
      target: PromotionTarget.CATEGORIES,
      targetIds: [parentCategoryId],
    });
    const b = browser();
    await b.add(sofa, 1);
    await b.add(lamp, 1);
    const view = await b.cart();
    expect(view.subtotal).toBe(150_000);
    expect(view.discount).toEqual({ labelHe: 'ספות ב־20%', amount: 20_000, source: 'automatic', code: null });
  });

  it('a coupon beaten by the automatic promotion stays, with the notice', async () => {
    await promotion({ name: 'מבצע גדול', kind: PromotionKind.AUTOMATIC, code: null, value: 30 });
    await promotion({ value: 10 });
    const b = browser();
    await b.add(sofa, 1);
    const view = (await b.apply('SAVE10').expect(200)).body as CartView;
    expect(view.couponCode).toBe('SAVE10');
    expect(view.discount).toMatchObject({ source: 'automatic', amount: 30_000 });
    expect(view.notices).toEqual([{ variantId: null, kind: 'coupon', messageHe: 'המבצע הנוכחי משתלם יותר מהקופון' }]);
  });

  it('a coupon below its minimum after a line is removed: kept, with the notice; exhausted: dropped once', async () => {
    const p = await promotion({ minSubtotal: 150_000, usageLimit: 1 });
    const b = browser();
    await b.add(sofa, 1);
    await b.add(lamp, 1);
    await b.apply('SAVE10').expect(200);
    await b.remove(lamp);
    let view = await b.cart();
    expect(view.discount).toBeNull();
    expect(view.couponCode).toBe('SAVE10');
    expect(view.notices).toEqual([{ variantId: null, kind: 'coupon', messageHe: 'הקופון תקף מסכום של 1,500 ₪' }]);

    await b.add(lamp, 1);
    expect((await b.cart()).discount?.amount).toBe(15_000);
    await prisma.promotion.update({ where: { id: p.id }, data: { usedCount: 1 } });
    view = await b.cart();
    expect(view.discount).toBeNull();
    expect(view.couponCode).toBeNull();
    expect(view.notices).toEqual([{ variantId: null, kind: 'coupon', messageHe: 'הקופון נוצל במלואו' }]);
    expect((await b.cart()).notices).toEqual([]);
  });

  it('checkout with a coupon: the order stores the discount and a snapshot; paid → used count +1', async () => {
    const p = await promotion({ name: 'עשרה אחוז', discountType: DiscountType.FIXED, value: 25_000 });
    const b = browser();
    await b.add(sofa, 2);
    await b.apply('save10').expect(200);
    const total = await b.expectedTotal();
    // 2 × 100,000 − 25,000 + delivery 40,000 + 50% of 40,000 for the second unit.
    expect(total).toBe(200_000 - 25_000 + 60_000);
    const tx = txOf(await b.checkout(total));
    const order = await orderOfTx(tx);
    expect(order).toMatchObject({
      subtotal: 200_000,
      discount: 25_000,
      shippingTotal: 60_000,
      total,
      promotionId: p.id,
      discountInfo: { name: 'עשרה אחוז', kind: 'coupon', code: 'SAVE10', labelHe: 'עשרה אחוז', source: 'coupon' },
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: tx } })).amount).toBe(total);
    const confirmation = (await http().get(`/api/orders/${order.number}?t=${order.publicToken}`).expect(200))
      .body as OrderView;
    expect(confirmation).toMatchObject({
      discount: 25_000,
      discountInfo: { labelHe: 'עשרה אחוז', source: 'coupon', code: 'SAVE10' },
    });

    expect(await usedCount(p.id)).toBe(0);
    await pay(tx).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAID);
    expect(await usedCount(p.id)).toBe(1);
    // A repeated webhook does not count twice.
    await pay(tx).expect(200);
    expect(await usedCount(p.id)).toBe(1);
  });

  it('checkout with an automatic promotion and no coupon', async () => {
    const p = await promotion({ name: 'מבצע חורף', kind: PromotionKind.AUTOMATIC, code: null, value: 10 });
    const b = browser();
    await b.add(lamp, 1);
    const order = await orderOfTx(txOf(await b.checkout()));
    expect(order).toMatchObject({
      subtotal: 50_000,
      discount: 5_000,
      total: 50_000 - 5_000 + 40_000,
      promotionId: p.id,
      discountInfo: { name: 'מבצע חורף', kind: 'automatic', code: null, source: 'automatic' },
    });
  });

  it('a coupon used up between the cart and the checkout → 409 coupon_invalid, nothing created', async () => {
    const p = await promotion({ usageLimit: 1 });
    const b = browser();
    await b.add(sofa, 1);
    await b.apply('SAVE10').expect(200);
    const total = await b.expectedTotal();
    await prisma.promotion.update({ where: { id: p.id }, data: { usedCount: 1 } });
    const res = await b.checkout(total);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      statusCode: 409,
      code: 'coupon_invalid',
      field: 'coupon',
      messageHe: 'הקופון נוצל במלואו',
    });
    expect(await prisma.order.count()).toBe(0);
  });

  it('a coupon that expired between the cart and the checkout → price_changed (the total the customer saw)', async () => {
    const p = await promotion();
    const b = browser();
    await b.add(sofa, 1);
    await b.apply('SAVE10').expect(200);
    const total = await b.expectedTotal();
    await prisma.promotion.update({ where: { id: p.id }, data: { endsAt: new Date(Date.now() - 1_000) } });
    const res = await b.checkout(total);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'price_changed', total: total + 10_000 });
    expect(await prisma.order.count()).toBe(0);
  });

  it('a pending order paid after the coupon limit was reached is honored and counted (Review Focus 5)', async () => {
    const p = await promotion({ usageLimit: 1 });
    const first = browser();
    const second = browser();
    for (const b of [first, second]) {
      await b.add(sofa, 1);
      await b.apply('SAVE10').expect(200);
    }
    // Both check out while the coupon is still unused: the limit counts paid orders only.
    const tx1 = txOf(await first.checkout());
    const tx2 = txOf(await second.checkout());

    await pay(tx2).expect(200);
    expect(await usedCount(p.id)).toBe(1);
    // A third customer can no longer check out with it.
    const third = browser();
    await third.add(sofa, 1);
    await third.apply('SAVE10').expect(400);

    // The first order is paid late: honored at its discounted total, and counted past the limit.
    await pay(tx1).expect(200);
    const late = await orderOfTx(tx1);
    expect(late).toMatchObject({ status: OrderStatus.PAID, discount: 10_000 });
    expect(await usedCount(p.id)).toBe(2);
  });

  it('a product-target coupon discounts only that product', async () => {
    await promotion({ code: 'SOFA', target: PromotionTarget.PRODUCTS, targetIds: [sofaProductId], value: 50 });
    const b = browser();
    await b.add(sofa, 1);
    await b.add(lamp, 1);
    const view = (await b.apply('sofa').expect(200)).body as CartView;
    expect(view.discount).toMatchObject({ amount: 50_000, code: 'SOFA' });
  });
});
