import { createHash } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type { OneTimeLink, StoreCartView } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { CartService } from './../src/cart/cart.service.js';
import { configureApp } from './../src/configure-app.js';
import {
  CustomerOrigin,
  DiscountType,
  OrderShippingMethod,
  PromotionKind,
  PromotionTarget,
} from './../src/generated/prisma/client.js';
import { lockStoreCart } from './../src/orders/locks.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteOrders } from './test-orders.js';

const STOREFRONT = 'http://localhost:4200';
const HOUR_MS = 60 * 60_000;

// The seller's store cart (Phase 6, ADM-18, spec §4.2): the website cart's code, owned by a seller.
describe('Store cart (e2e, ADM-18)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let sellerA: AdminBrowser;
  let sellerB: AdminBrowser;
  let sellerAId: number;
  let variantA: number;
  let variantB: number;
  let customerId: string;

  const view = (res: request.Response) => res.body as StoreCartView;
  const cleanData = async () => {
    await deleteOrders(prisma, { contact: { path: ['fullName'], string_starts_with: 'ZZ' } });
    await prisma.cart.deleteMany();
    await prisma.promotion.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
  };
  const coupon = () =>
    prisma.promotion.create({
      data: {
        name: 'ZZ קופון',
        kind: PromotionKind.COUPON,
        code: 'ZZSAVE10',
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
      },
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanData();
    await prisma.customer.deleteMany({ where: { fullName: { startsWith: 'ZZ' } } });
    // The owner is the second seller: the Super Admin passes every permission check.
    ({ owner: sellerB, other: sellerA } = await signInOwnerAnd(app, 'store_seller'));
    sellerAId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'store_seller@example.test' } })).id;

    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'corner-sofas' } });
    const size = { widthCm: 280, depthCm: 95, heightCm: 85 };
    const product = await prisma.product.create({
      data: {
        slug: 'zz-store-cart-sofa',
        modelName: 'ZZSTORE',
        nameHe: 'ספת בדיקה',
        categoryId: sofas.id,
        variants: {
          create: [
            { sku: 'ZZSTORE-1', price: 100_000, stock: 5, leadTimeDays: 14, sortOrder: 0, ...size },
            { sku: 'ZZSTORE-2', price: 50_000, stock: 5, leadTimeDays: 14, sortOrder: 1, ...size },
          ],
        },
      },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    [variantA, variantB] = product.variants.map((v) => v.id);
    await app.get(CacheStore).invalidate('catalog:');
    customerId = (
      await prisma.customer.create({
        data: {
          fullName: 'ZZ לקוח חנות',
          phone: '0501112233',
          email: null,
          createdVia: CustomerOrigin.STORE,
          createdBySellerId: sellerAId,
        },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanData();
    await prisma.customer.deleteMany({ where: { fullName: { startsWith: 'ZZ' } } });
    await resetAdminData(prisma);
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  afterEach(cleanData);

  it('prices exactly like the website: same totals for the same lines and coupon', async () => {
    await coupon();
    await sellerA.post('/store-cart').expect(201);
    await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 2 }).expect(201);
    await sellerA.post('/store-cart/items', { variantId: variantB, quantity: 1 }).expect(201);
    const store = view(await sellerA.post('/store-cart/coupon', { code: 'zzsave10' }).expect(201));

    const guest = request.agent(app.getHttpServer());
    await guest.post('/api/cart/items').set('Origin', STOREFRONT).send({ variantId: variantA, quantity: 2 });
    await guest.post('/api/cart/items').set('Origin', STOREFRONT).send({ variantId: variantB, quantity: 1 });
    await guest.post('/api/cart/coupon').set('Origin', STOREFRONT).send({ code: 'ZZSAVE10' });
    const web = (await guest.get('/api/cart')).body;

    const { customer, ...storeCart } = store;
    expect(customer).toBeNull();
    expect(storeCart).toEqual(web);
    expect(store.subtotal).toBe(250_000);
    expect(store.discount?.amount).toBe(25_000);

    const patched = view(await sellerA.patch(`/store-cart/items/${variantB}`, { quantity: 3 }).expect(200));
    expect(patched.subtotal).toBe(350_000);
    const removed = view(await sellerA.delete(`/store-cart/items/${variantB}`).expect(200));
    expect(removed.itemCount).toBe(2);
    const noCoupon = view(await sellerA.delete('/store-cart/coupon').expect(200));
    expect(noCoupon.couponCode).toBeNull();
    expect(view(await sellerA.get('/store-cart').expect(200)).itemCount).toBe(2);
  });

  it('sets no cookie and keeps customerId empty', async () => {
    const res = await sellerA.post('/store-cart').expect(201);
    expect(res.headers['set-cookie']).toBeUndefined();
    const added = await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).expect(201);
    expect(added.headers['set-cookie']).toBeUndefined();
    const cart = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    expect(cart.customerId).toBeNull();
  });

  it('answers 204 when the seller has no open cart, and 404 for a change', async () => {
    await sellerA.get('/store-cart').expect(204);
    await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).expect(404);
  });

  it("never lets another seller read or change a seller's cart", async () => {
    await sellerA.post('/store-cart').expect(201);
    await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).expect(201);
    await sellerB.get('/store-cart').expect(204);
    await sellerB.post('/store-cart/items', { variantId: variantB, quantity: 1 }).expect(404);
    const cart = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    // Even naming the cart by id: the service answers only to its seller.
    const cartService = app.get(CartService);
    const other = { token: undefined, customerId: null, store: { sellerId: sellerAId + 1000, cartId: cart.id } };
    expect(await cartService.resolve(other)).toBeNull();
    expect(await cartService.resolve({ ...other, store: { sellerId: sellerAId, cartId: cart.id } })).toEqual({
      id: cart.id,
    });
    expect(await prisma.cartItem.count({ where: { cartId: cart.id } })).toBe(1);
  });

  it('refuses a store cart without the orders.store permission', async () => {
    const created = await sellerB
      .post('/users', { email: 'viewer@example.test', name: 'צופה', template: 'content_editor' })
      .expect(201);
    const viewer = await acceptAndSignIn(
      app,
      { email: 'viewer@example.test', password: 'pebble garden lantern ocean' },
      created.body.invite as OneTimeLink,
    );
    await viewer.get('/store-cart').expect(403);
    await viewer.post('/store-cart').expect(403);
  });

  it('never merges: sign-in does not move lines between a store cart and an account cart', async () => {
    const storeCart = await prisma.cart.create({
      data: {
        tokenHash: createHash('sha256').update('zz-known-token').digest('hex'),
        sellerId: sellerAId,
        storeCustomerId: customerId,
        storeConfirmedAt: new Date(),
        items: { create: { variantId: variantA, quantity: 2, unitPriceAtAdd: 100_000 } },
      },
    });
    const accountCart = await prisma.cart.create({
      data: {
        tokenHash: 'zz-account-cart',
        customerId,
        items: { create: { variantId: variantB, quantity: 1, unitPriceAtAdd: 50_000 } },
      },
    });
    await app.get(CartService).attachToCustomer(undefined, customerId);
    expect(await prisma.cartItem.findMany({ where: { cartId: storeCart.id } })).toEqual([
      expect.objectContaining({ variantId: variantA, quantity: 2 }),
    ]);
    expect(await prisma.cartItem.findMany({ where: { cartId: accountCart.id } })).toEqual([
      expect.objectContaining({ variantId: variantB, quantity: 1 }),
    ]);
    expect((await prisma.cart.findUniqueOrThrow({ where: { id: storeCart.id } })).customerId).toBeNull();

    // A guest request that carries the store cart's own token (guessed or leaked) does not reach it.
    const guest = await request(app.getHttpServer()).get('/api/cart').set('Cookie', 'hg_cart=zz-known-token');
    expect(guest.body.lines).toEqual([]);
  });

  it('offers the welcome benefit to the attached customer, as on the website', async () => {
    await prisma.promotion.create({
      data: {
        name: 'ZZ הטבת הצטרפות',
        kind: PromotionKind.AUTOMATIC,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        isWelcome: true,
      },
    });
    await sellerA.post('/store-cart').expect(201);
    const before = view(await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).expect(201));
    expect(before.discount).toBeNull();
    await prisma.cart.updateMany({ where: { sellerId: sellerAId }, data: { storeCustomerId: customerId } });
    const withCustomer = view(await sellerA.get('/store-cart').expect(200));
    expect(withCustomer.discount?.amount).toBe(10_000);
    expect(withCustomer.customer).toEqual({
      id: customerId,
      fullName: 'ZZ לקוח חנות',
      phone: '0501112233',
      email: null,
      emailVerified: false,
      isNew: true,
      marketingStatus: null,
    });
  });

  it('starts a new sale: replaces the open cart, but never touches a cart that has an order', async () => {
    await sellerA.post('/store-cart').expect(201);
    await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).expect(201);
    const first = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    const fresh = view(await sellerA.post('/store-cart').expect(201));
    expect(fresh.lines).toEqual([]);
    expect(await prisma.cart.findUnique({ where: { id: first.id } })).toBeNull();
    expect(await prisma.cart.count({ where: { sellerId: sellerAId } })).toBe(1);

    // A cart with an order is not "open": a new sale leaves it alone and its orders stay reachable.
    const second = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    await prisma.order.create({
      data: {
        publicToken: 'zz-store-cart-order',
        contact: { fullName: 'ZZ הזמנה', phone: '0501112233', email: null },
        address: {},
        method: OrderShippingMethod.CURBSIDE,
        shippingTotal: 0,
        shippingLines: [],
        subtotal: 0,
        total: 0,
        deliveryEstimate: {},
        paymentProvider: 'sandbox',
        shippingProvider: 'manual',
        reservedUntil: new Date(Date.now() + 20 * 60_000),
        cartId: second.id,
      },
    });
    await sellerA.get('/store-cart').expect(204);
    await sellerA.post('/store-cart').expect(201);
    expect(await prisma.cart.findUnique({ where: { id: second.id } })).not.toBeNull();
    expect(await prisma.cart.count({ where: { sellerId: sellerAId } })).toBe(2);
  });

  it('lapses the customer confirmation after two hours', async () => {
    await sellerA.post('/store-cart').expect(201);
    await prisma.cart.updateMany({
      where: { sellerId: sellerAId },
      data: { storeCustomerId: customerId, storeConfirmedAt: new Date() },
    });
    expect(view(await sellerA.get('/store-cart').expect(200)).customer?.id).toBe(customerId);

    await prisma.cart.updateMany({
      where: { sellerId: sellerAId },
      data: { storeConfirmedAt: new Date(Date.now() - 3 * HOUR_MS) },
    });
    const lapsed = view(await sellerA.get('/store-cart').expect(200));
    expect(lapsed.customer).toBeNull();
    const row = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    expect(row.storeCustomerId).toBeNull();
    expect(row.storeConfirmedAt).toBeNull();
  });

  it('lapses the customer confirmation when the cart was idle for two hours', async () => {
    await sellerA.post('/store-cart').expect(201);
    await sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).expect(201);
    // Confirmed recently, but the cart itself has not been used for more than two hours.
    await prisma.cart.updateMany({
      where: { sellerId: sellerAId },
      data: {
        storeCustomerId: customerId,
        storeConfirmedAt: new Date(Date.now() - 30 * 60_000),
        updatedAt: new Date(Date.now() - 2 * HOUR_MS - 60_000),
      },
    });
    const lapsed = view(await sellerA.get('/store-cart').expect(200));
    expect(lapsed.customer).toBeNull();
    // The lines stay.
    expect(lapsed.itemCount).toBe(1);
    const row = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    expect(row.storeCustomerId).toBeNull();
    expect(row.storeConfirmedAt).toBeNull();
  });

  it('a line or coupon change waits for a store checkout in progress, then refuses the cart that got its order', async () => {
    await sellerA.post('/store-cart').expect(201);
    const cart = await prisma.cart.findFirstOrThrow({ where: { sellerId: sellerAId } });
    // A store checkout holding the seller's store-cart lock while it creates the cart's order.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let holding!: () => void;
    const held = new Promise<void>((resolve) => (holding = resolve));
    const checkout = prisma.$transaction(
      async (tx) => {
        await lockStoreCart(tx, sellerAId);
        holding();
        await gate;
        await tx.order.create({
          data: {
            publicToken: 'zz-store-cart-lock',
            contact: { fullName: 'ZZ הזמנה', phone: '0501112233', email: null },
            address: {},
            method: OrderShippingMethod.CURBSIDE,
            shippingTotal: 0,
            shippingLines: [],
            subtotal: 0,
            total: 0,
            deliveryEstimate: {},
            paymentProvider: 'sandbox',
            shippingProvider: 'manual',
            reservedUntil: new Date(Date.now() + 20 * 60_000),
            cartId: cart.id,
          },
        });
      },
      { timeout: 15_000 },
    );
    await held;
    const add = sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }).then((r) => r);
    const removeCoupon = sellerA.delete('/store-cart/coupon').then((r) => r);
    // Long enough for both requests to reach the lock (without it they would finish on the cart meanwhile).
    await new Promise((resolve) => setTimeout(resolve, 400));
    release();
    await checkout;
    expect((await add).status).toBe(404);
    expect((await removeCoupon).status).toBe(404);
    expect(await prisma.cartItem.count({ where: { cartId: cart.id } })).toBe(0);
  });

  it('a new sale racing line changes never fails with a server error', async () => {
    await sellerA.post('/store-cart').expect(201);
    for (let round = 0; round < 5; round++) {
      const answers = await Promise.all([
        sellerA.post('/store-cart/items', { variantId: variantA, quantity: 1 }),
        sellerA.post('/store-cart'),
        sellerA.post('/store-cart/items', { variantId: variantB, quantity: 1 }),
        sellerA.patch(`/store-cart/items/${variantA}`, { quantity: 2 }),
      ]);
      for (const res of answers) expect([200, 201, 404], JSON.stringify(res.body)).toContain(res.status);
    }
    expect(await prisma.cart.count({ where: { sellerId: sellerAId, orders: { none: {} } } })).toBe(1);
  });

  it('concurrent new sales leave the seller exactly one open cart', async () => {
    await Promise.all(Array.from({ length: 5 }, () => sellerA.post('/store-cart').expect(201)));
    expect(await prisma.cart.count({ where: { sellerId: sellerAId, orders: { none: {} } } })).toBe(1);
  });
});
