import type { AddressInfo } from 'node:net';
import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type {
  AccountOrdersPage,
  CartView,
  CheckoutPrefill,
  CheckoutRequest,
  CheckoutResponse,
  CustomerAddressView,
  OrderView,
  ShippingQuote,
} from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { hashPassword } from './../src/auth/passwords.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  DiscountType,
  MarketingConsentSource,
  OrderStatus,
  PromotionKind,
  PromotionTarget,
} from './../src/generated/prisma/client.js';
import { SMS_PROVIDER, type SmsProvider } from './../src/notifications/notification-provider.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { deleteOrders } from './test-orders.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@acc12.e2e.test';
const PASSWORD = 'correct horse 12';
const COUPON = 'ZZACC12';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;

// Account data, cart merge and checkout with a customer (spec §6.3, §6.4, ACC-03, ACC-04, ACC-05, decision 77).
describe('Customer account data (e2e, ACC-03, ACC-04, ACC-05)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let passwordHash: string;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  /** 100,000 a unit, 4 in stock. */
  let sofa: number;
  /** 50,000 a unit, 100 in stock. */
  let lamp: number;
  let seq = 0;

  const unique = () => String(++seq).padStart(4, '0') + String(Date.now() % 10_000).padStart(4, '0');

  /** A customer with a password (created directly; sign-in goes through the API). */
  const newCustomer = async () => {
    const id = unique();
    return prisma.customer.create({
      data: {
        fullName: 'דנה לוי',
        phone: `05${id}`,
        email: `user${id}${DOMAIN}`,
        passwordHash,
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });
  };

  /** A storefront browser: keeps cookies and sends the storefront's Origin on writes. */
  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    const write = (method: 'post' | 'put' | 'delete', path: string, body?: object) =>
      agent[method](path).set('Origin', ORIGIN).send(body);
    return {
      agent,
      write,
      signIn: (email: string) => write('post', '/api/account/sign-in', { email, password: PASSWORD }).expect(200),
      signOut: () => write('post', '/api/account/sign-out').expect(204),
      cart: async () => (await agent.get('/api/cart').expect(200)).body as CartView,
      add: (variantId: number, quantity: number) =>
        write('post', '/api/cart/items', { variantId, quantity }).expect(200),
      expectedTotal: async () => {
        const view = (await agent.get('/api/cart').expect(200)).body as CartView;
        const quote = (
          await write('post', '/api/shipping/quote', { localityId: LOCALITY, floor: 0, hasElevator: true }).expect(200)
        ).body as ShippingQuote;
        return view.subtotal - (view.discount?.amount ?? 0) + quote.methods.find((m) => m.method === 'curbside')!.total;
      },
      checkout: async (extra: Partial<CheckoutRequest> = {}, contact = checkoutBody().contact) =>
        write('post', '/api/checkout', {
          ...checkoutBody(),
          contact,
          expectedTotal: await browserTotal(agent),
          ...extra,
        }),
    };
  };
  type Browser = ReturnType<typeof browser>;
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
  const address = (extra: Record<string, unknown> = {}) => ({
    localityId: LOCALITY,
    street: 'הרצל',
    houseNumber: '12',
    apartment: '3',
    floor: 2,
    hasElevator: true,
    notes: null,
    ...extra,
  });
  const orderOf = async (res: request.Response) => {
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const { redirectUrl } = res.body as CheckoutResponse;
    const transactionId = /\/pay\/sandbox\/([\w-]+)$/.exec(redirectUrl)![1];
    return (await prisma.payment.findUniqueOrThrow({ where: { transactionId }, include: { order: true } })).order;
  };
  /** A signed-in browser with one lamp in its cart, checked out: the account's pending order. */
  const placeOrder = async (b: Browser, extra: Partial<CheckoutRequest> = {}) => {
    await b.add(lamp, 1);
    return orderOf(await b.checkout(extra));
  };

  const cleanup = async () => {
    await deleteOrders(prisma);
    await prisma.cart.deleteMany();
    await prisma.customer.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.promotion.deleteMany({ where: { code: COUPON } });
    await prisma.otpCode.deleteMany({ where: { target: { startsWith: '05' } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    passwordHash = await hashPassword(PASSWORD);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    await cleanup();
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZACC' } } });
    await prisma.category.deleteMany({ where: { slug: 'zz-acc12' } });

    const category = await prisma.category.create({
      data: {
        slug: 'zz-acc12',
        nameHe: 'בדיקת חשבון',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const size = { widthCm: 200, depthCm: 90, heightCm: 80, leadTimeDays: 7 };
    const product = await prisma.product.create({
      data: {
        slug: 'zz-acc12-sofa',
        modelName: 'ZZACC',
        nameHe: 'ספת חשבון',
        categoryId: category.id,
        variants: {
          create: [
            { sku: 'ZZACC-1', price: 100_000, stock: 4, sortOrder: 0, ...size },
            { sku: 'ZZACC-2', price: 50_000, stock: 100, sortOrder: 1, ...size, widthCm: 220 },
          ],
        },
      },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    [sofa, lamp] = product.variants.map((v) => v.id);
    await app.get(CacheStore).invalidate('catalog:');
  });

  afterAll(async () => {
    await cleanup();
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZACC' } } });
    await prisma.category.deleteMany({ where: { slug: 'zz-acc12' } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  afterEach(cleanup);

  describe('addresses', () => {
    it('need a session and the storefront origin; never cached', async () => {
      const b = browser();
      await b.agent.get('/api/account/addresses').expect(401);
      await b.write('post', '/api/account/addresses', address()).expect(401);
      const c = await newCustomer();
      await b.signIn(c.email);
      await b.agent.post('/api/account/addresses').send(address()).expect(403);
      const res = await b.agent.get('/api/account/addresses').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toEqual([]);
    });

    it('add, edit, delete; exactly one default; the same validation as checkout', async () => {
      const c = await newCustomer();
      const b = browser();
      await b.signIn(c.email);

      const first = (await b.write('post', '/api/account/addresses', address()).expect(201))
        .body as CustomerAddressView;
      // The first address is the default.
      expect(first).toMatchObject({ ...address(), isDefault: true, localityNameHe: expect.any(String) });
      const second = (
        await b.write('post', '/api/account/addresses', address({ street: 'ביאליק', isDefault: true })).expect(201)
      ).body as CustomerAddressView;
      expect(second.isDefault).toBe(true);
      let list = (await b.agent.get('/api/account/addresses').expect(200)).body as CustomerAddressView[];
      expect(list.map((a) => [a.id, a.isDefault])).toEqual([
        [second.id, true],
        [first.id, false],
      ]);

      // Edit: the default moves back to the first.
      const edited = (
        await b
          .write('put', `/api/account/addresses/${first.id}`, address({ street: '  רוטשילד ', isDefault: true }))
          .expect(200)
      ).body as CustomerAddressView;
      expect(edited).toMatchObject({ street: 'רוטשילד', isDefault: true });
      list = (await b.agent.get('/api/account/addresses').expect(200)).body as CustomerAddressView[];
      expect(list.filter((a) => a.isDefault).map((a) => a.id)).toEqual([first.id]);

      // The checkout rules (field + Hebrew message), and an unknown locality.
      const bad = await b.write('post', '/api/account/addresses', address({ floor: 61 })).expect(400);
      expect(bad.body).toMatchObject({ code: 'invalid_field', field: 'address.floor', messageHe: expect.any(String) });
      const unknown = await b.write('post', '/api/account/addresses', address({ localityId: 999_999 })).expect(400);
      expect(unknown.body).toMatchObject({ code: 'invalid_field', field: 'address.localityId' });
      await b.write('post', '/api/account/addresses', address({ isDefault: 'yes' })).expect(400);

      // Deleting the default: the remaining address becomes the default.
      await b.write('delete', `/api/account/addresses/${first.id}`).expect(204);
      list = (await b.agent.get('/api/account/addresses').expect(200)).body as CustomerAddressView[];
      expect(list).toEqual([expect.objectContaining({ id: second.id, isDefault: true })]);
      expect(await prisma.customerAddress.count({ where: { customerId: c.id } })).toBe(1);
    });

    it("another customer's address is 404 (no IDOR)", async () => {
      const owner = browser();
      const other = browser();
      await owner.signIn((await newCustomer()).email);
      await other.signIn((await newCustomer()).email);
      const mine = (await owner.write('post', '/api/account/addresses', address()).expect(201))
        .body as CustomerAddressView;

      await other.write('put', `/api/account/addresses/${mine.id}`, address({ street: 'גנב' })).expect(404);
      await other.write('delete', `/api/account/addresses/${mine.id}`).expect(404);
      await other.write('delete', '/api/account/addresses/not-a-uuid').expect(404);
      expect((await other.agent.get('/api/account/addresses').expect(200)).body).toEqual([]);
      expect(await prisma.customerAddress.findUniqueOrThrow({ where: { id: mine.id } })).toMatchObject({
        street: 'הרצל',
      });
    });
  });

  describe('orders', () => {
    it('checkout with a session stores customerId; the account lists only its own orders (decision 77)', async () => {
      const c = await newCustomer();
      const b = browser();
      await b.signIn(c.email);
      const order = await placeOrder(b);
      expect(order.customerId).toBe(c.id);

      // A guest order with the same phone and e-mail is never linked or shown.
      const guest = browser();
      await guest.add(lamp, 1);
      const guestOrder = await orderOf(
        await guest.checkout({}, { fullName: 'ZZ אורח', phone: c.phone, email: c.email }),
      );
      expect(guestOrder.customerId).toBeNull();

      // Another customer's order.
      const other = browser();
      await other.signIn((await newCustomer()).email);
      const otherOrder = await placeOrder(other);

      const page = await b.agent.get('/api/account/orders').expect(200);
      expect(page.headers['cache-control']).toBe('no-store');
      expect(page.body as AccountOrdersPage).toEqual({
        items: [
          {
            number: order.number,
            status: 'pending_payment',
            statusLabelHe: expect.any(String),
            createdAt: order.createdAt.toISOString(),
            total: order.total,
            itemCount: 1,
          },
        ],
        page: 1,
        pageSize: 10,
        total: 1,
      });

      const view = (await b.agent.get(`/api/account/orders/${order.number}`).expect(200)).body as OrderView;
      expect(view).toMatchObject({ number: order.number, total: order.total, canCancel: true });
      await b.agent.get(`/api/account/orders/${guestOrder.number}`).expect(404);
      await b.agent.get(`/api/account/orders/${otherOrder.number}`).expect(404);
      await b.agent.get('/api/account/orders/abc').expect(404);
      await browser().agent.get(`/api/account/orders/${order.number}`).expect(401);
      await browser().agent.get('/api/account/orders').expect(401);
    });

    it('pages newest first', async () => {
      const c = await newCustomer();
      const b = browser();
      await b.signIn(c.email);
      const numbers: number[] = [];
      for (let i = 0; i < 11; i++) {
        // The account's one cart each time: each checkout expires its earlier pending order, which stays the account's.
        numbers.push((await placeOrder(b)).number);
      }
      const first = (await b.agent.get('/api/account/orders').expect(200)).body as AccountOrdersPage;
      expect(first).toMatchObject({ page: 1, pageSize: 10, total: 11 });
      expect(first.items.map((o) => o.number)).toEqual(numbers.slice(1).reverse());
      const second = (await b.agent.get('/api/account/orders?page=2').expect(200)).body as AccountOrdersPage;
      expect(second.items.map((o) => o.number)).toEqual([numbers[0]]);
      await b.agent.get('/api/account/orders?page=0').expect(400);
      await b.agent.get('/api/account/orders?page=x').expect(400);
    });

    it('cancels its own unpaid order (the same lifecycle rules); never another customer’s', async () => {
      const c = await newCustomer();
      const b = browser();
      await b.signIn(c.email);
      const order = await placeOrder(b);
      const other = browser();
      await other.signIn((await newCustomer()).email);

      await other.write('post', `/api/account/orders/${order.number}/cancel`).expect(404);
      await b.agent.post(`/api/account/orders/${order.number}/cancel`).expect(403);
      const cancelled = (await b.write('post', `/api/account/orders/${order.number}/cancel`).expect(201))
        .body as OrderView;
      expect(cancelled).toMatchObject({ status: 'cancelled', canCancel: false });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.CANCELLED);
      const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
      expect(events).toEqual([expect.objectContaining({ toStatus: OrderStatus.CANCELLED, actorType: 'CUSTOMER' })]);
      const again = await b.write('post', `/api/account/orders/${order.number}/cancel`).expect(409);
      expect(again.body).toMatchObject({ code: 'invalid_transition' });
    });
  });

  it('consent on and off: time and source recorded, withdrawal time kept', async () => {
    const c = await newCustomer();
    const b = browser();
    await browser().write('put', '/api/account/consent', { marketingConsent: true }).expect(401);
    await b.signIn(c.email);
    await b.write('put', '/api/account/consent', { marketingConsent: 'yes' }).expect(400);

    const on = await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(200);
    expect(on.headers['cache-control']).toBe('no-store');
    let row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(row).toMatchObject({
      marketingConsent: true,
      marketingConsentSource: MarketingConsentSource.ACCOUNT,
      marketingWithdrawnAt: null,
    });
    expect(row.marketingConsentAt).toBeInstanceOf(Date);
    expect(on.body).toEqual({
      marketingConsent: true,
      marketingConsentAt: row.marketingConsentAt!.toISOString(),
      marketingConsentSource: 'account',
      marketingWithdrawnAt: null,
    });
    const consentAt = row.marketingConsentAt;
    // The same answer again changes nothing.
    await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(200);
    expect((await prisma.customer.findUniqueOrThrow({ where: { id: c.id } })).marketingConsentAt).toEqual(consentAt);

    const off = await b.write('put', '/api/account/consent', { marketingConsent: false }).expect(200);
    row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.marketingConsent).toBe(false);
    expect(row.marketingWithdrawnAt).toBeInstanceOf(Date);
    expect(off.body).toMatchObject({
      marketingConsent: false,
      marketingWithdrawnAt: row.marketingWithdrawnAt!.toISOString(),
    });
    expect((await b.agent.get('/api/account/me').expect(200)).body).toMatchObject({ marketingConsent: false });

    // Consent again: a new time, and the withdrawal is cleared.
    const again = await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(200);
    expect(again.body).toMatchObject({ marketingConsent: true, marketingWithdrawnAt: null });
    row = await prisma.customer.findUniqueOrThrow({ where: { id: c.id } });
    expect(row.marketingWithdrawnAt).toBeNull();
    expect(row.marketingConsentAt!.getTime()).toBeGreaterThanOrEqual(consentAt!.getTime());
  });

  it('address and consent writes are rate limited per IP (bucket account)', async () => {
    const throttle = app.get(WriteThrottle);
    throttle.setLimit('account', 2);
    try {
      const b = browser();
      await b.signIn((await newCustomer()).email);
      await b.write('post', '/api/account/addresses', address()).expect(201);
      await b.write('put', '/api/account/consent', { marketingConsent: true }).expect(200);
      const limited = await b.write('post', '/api/account/addresses', address()).expect(429);
      expect(limited.body).toMatchObject({ code: 'too_many_requests' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
      // Reads are not limited.
      await b.agent.get('/api/account/addresses').expect(200);
    } finally {
      throttle.setLimit('account', 100_000);
    }
  });

  describe('one cart per account, merged on sign-in', () => {
    const lines = (view: CartView) => view.lines.map((l) => [l.variantId, l.quantity]).sort((a, z) => a[0] - z[0]);
    const sorted = (pairs: number[][]) => [...pairs].sort((a, z) => a[0] - z[0]);
    const cartCookie = (res: request.Response) =>
      ([res.headers['set-cookie'] ?? []].flat() as string[]).find((h) => h.startsWith('hg_cart='));

    it('the first sign-in links the guest cart; the cookie is dropped and the session finds the cart', async () => {
      const c = await newCustomer();
      const b = browser();
      await b.add(lamp, 2);
      const signIn = await b.signIn(c.email);
      expect(cartCookie(signIn)).toMatch(/^hg_cart=;/);
      const carts = await prisma.cart.findMany();
      expect(carts).toEqual([expect.objectContaining({ customerId: c.id })]);
      expect(lines(await b.cart())).toEqual([[lamp, 2]]);
    });

    it("the account's cart absorbs the guest lines (summed, clamped); the guest cart is deleted", async () => {
      const c = await newCustomer();
      const phone = browser();
      await phone.signIn(c.email);
      await phone.add(sofa, 2);
      await phone.add(lamp, 1);
      const customerCart = await prisma.cart.findFirstOrThrow({ where: { customerId: c.id } });

      const laptop = browser();
      await laptop.add(sofa, 3);
      await laptop.add(lamp, 5);
      const guestCart = await prisma.cart.findFirstOrThrow({ where: { customerId: null } });
      await laptop.signIn(c.email);

      expect(await prisma.cart.findUnique({ where: { id: guestCart.id } })).toBeNull();
      const items = await prisma.cartItem.findMany({ where: { cartId: customerCart.id } });
      // 2 + 3 sofas clamped to the 4 in stock; 1 + 5 lamps.
      const merged = sorted([
        [sofa, 4],
        [lamp, 6],
      ]);
      expect(sorted(items.map((i) => [i.variantId, i.quantity]))).toEqual(merged);
      // Both browsers see the same cart.
      expect(lines(await laptop.cart())).toEqual(merged);
      expect(lines(await phone.cart())).toEqual(merged);
      expect(await prisma.cart.count()).toBe(1);
    });

    it('two sessions of one account see and change the same cart; sign-out drops it', async () => {
      const c = await newCustomer();
      const first = browser();
      const second = browser();
      await first.signIn(c.email);
      await second.signIn(c.email);
      await first.add(lamp, 1);
      await second.add(sofa, 1);
      await second.agent.patch(`/api/cart/items/${lamp}`).set('Origin', ORIGIN).send({ quantity: 3 }).expect(200);
      const both = sorted([
        [sofa, 1],
        [lamp, 3],
      ]);
      expect(lines(await first.cart())).toEqual(both);
      expect(lines(await second.cart())).toEqual(both);
      await first.write('delete', `/api/cart/items/${sofa}`).expect(200);
      expect(lines(await second.cart())).toEqual([[lamp, 3]]);
      expect(await prisma.cart.count({ where: { customerId: c.id } })).toBe(1);
      // The shipping quote and checkout use the same cart.
      const order = await orderOf(await second.checkout());
      expect(order.cartId).toBe((await prisma.cart.findFirstOrThrow({ where: { customerId: c.id } })).id);

      await second.signOut();
      expect((await second.cart()).lines).toEqual([]);
      expect(lines(await first.cart())).toEqual([[lamp, 3]]);
    });

    it('an older second cart of the account is absorbed at the next sign-in', async () => {
      const c = await newCustomer();
      const b = browser();
      await b.signIn(c.email);
      await b.add(lamp, 1);
      const newest = await prisma.cart.findFirstOrThrow({ where: { customerId: c.id } });
      const older = await prisma.cart.create({
        data: {
          tokenHash: `zz-older-${c.id}`,
          customerId: c.id,
          couponCode: null,
          updatedAt: new Date(Date.now() - 60_000),
          items: {
            create: [
              { variantId: lamp, quantity: 2, unitPriceAtAdd: 50_000 },
              { variantId: sofa, quantity: 1, unitPriceAtAdd: 100_000 },
            ],
          },
        },
      });
      // Not merged before a sign-in: the session reads the newest cart.
      expect(lines(await b.cart())).toEqual([[lamp, 1]]);
      const other = browser();
      await other.signIn(c.email);
      expect(await prisma.cart.findUnique({ where: { id: older.id } })).toBeNull();
      const merged = sorted([
        [sofa, 1],
        [lamp, 3],
      ]);
      expect(lines(await other.cart())).toEqual(merged);
      expect(lines(await b.cart())).toEqual(merged);
      expect((await prisma.cart.findMany({ where: { customerId: c.id } })).map((x) => x.id)).toEqual([newest.id]);
    });

    it('merges on a sign-in by SMS code too', async () => {
      const c = await newCustomer();
      const phone = browser();
      await phone.signIn(c.email);
      await phone.add(lamp, 1);
      const guest = browser();
      await guest.add(lamp, 2);
      await guest
        .write('post', '/api/account/otp/request', { target: c.phone, channel: 'sms', purpose: 'sign_in' })
        .expect(202);
      const call = smsSpy.mock.calls.filter(([m]) => m.to === c.phone).at(-1)!;
      const code = /(\d{6})/.exec(call[0].text)![1];
      await guest.write('post', '/api/account/otp/verify', { target: c.phone, code }).expect(200);
      expect(lines(await guest.cart())).toEqual([[lamp, 3]]);
      expect(await prisma.cart.count()).toBe(1);
    });

    it("the guest cart's coupon carries over when the account's cart has none", async () => {
      await prisma.promotion.create({
        data: {
          name: 'ZZ קופון חשבון',
          kind: PromotionKind.COUPON,
          code: COUPON,
          discountType: DiscountType.PERCENT,
          value: 10,
          target: PromotionTarget.ORDER,
        },
      });
      const c = await newCustomer();
      const phone = browser();
      await phone.signIn(c.email);
      await phone.add(lamp, 1);
      const guest = browser();
      await guest.add(sofa, 1);
      await guest.write('post', '/api/cart/coupon', { code: COUPON }).expect(200);
      await guest.signIn(c.email);
      const view = await phone.cart();
      expect(view.couponCode).toBe(COUPON);
      expect(view.discount).toMatchObject({ code: COUPON, amount: 15_000 });
    });

    it('a guest cart with a live pending order is emptied and detached, not deleted (the order keeps its cart)', async () => {
      const c = await newCustomer();
      const phone = browser();
      await phone.signIn(c.email);
      await phone.add(sofa, 1);
      const guest = browser();
      await guest.add(lamp, 1);
      const order = await orderOf(await guest.checkout());
      await guest.signIn(c.email);
      const kept = await prisma.cart.findUniqueOrThrow({ where: { id: order.cartId! }, include: { items: true } });
      expect(kept).toMatchObject({ customerId: null, items: [] });
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).cartId).toBe(kept.id);
      expect(lines(await guest.cart())).toEqual(
        sorted([
          [sofa, 1],
          [lamp, 1],
        ]),
      );
    });

    it('a double-submitted sign-in merges once and answers 200 twice', async () => {
      const c = await newCustomer();
      const phone = browser();
      await phone.signIn(c.email);
      await phone.add(lamp, 1);
      const guest = browser();
      await guest.add(lamp, 2);
      const send = () => guest.write('post', '/api/account/sign-in', { email: c.email, password: PASSWORD });
      const results = await Promise.all([send(), send()]);
      expect(results.map((r) => r.status)).toEqual([200, 200]);
      expect(lines(await phone.cart())).toEqual([[lamp, 3]]);
      expect(await prisma.cart.count()).toBe(1);
    });

    for (const withPendingOrder of [false, true]) {
      it(`a double-submitted first sign-in (no account cart${withPendingOrder ? ', guest cart with a live order' : ''}) links the cart once`, async () => {
        const c = await newCustomer();
        const guest = browser();
        await guest.add(lamp, 2);
        const guestCart = await prisma.cart.findFirstOrThrow({ where: { customerId: null } });
        const order = withPendingOrder ? await orderOf(await guest.checkout()) : null;
        const send = () => guest.write('post', '/api/account/sign-in', { email: c.email, password: PASSWORD });
        // Several rounds: the two requests must overlap at least once.
        const results = await Promise.all([send(), send(), send()]);
        expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
        const carts = await prisma.cart.findMany({ where: { customerId: c.id }, include: { items: true } });
        expect(carts).toHaveLength(1);
        expect(carts[0].id).toBe(guestCart.id);
        expect(carts[0].items.map((i) => [i.variantId, i.quantity])).toEqual([[lamp, 2]]);
        if (order)
          expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).cartId).toBe(guestCart.id);
        expect(lines(await guest.cart())).toEqual([[lamp, 2]]);
      });
    }

    it("another account's cart left in the browser is not merged or shown", async () => {
      const a = await newCustomer();
      const z = await newCustomer();
      const b = browser();
      // A's guest cart, then A signs in: it becomes A's cart. Its old cookie is replayed by hand while Z signs in.
      const cookie = cartCookie(await b.add(lamp, 1))!;
      await b.signIn(a.email);
      const aCart = await prisma.cart.findFirstOrThrow({ where: { customerId: a.id } });
      const z1 = browser();
      await z1.agent
        .post('/api/account/sign-in')
        .set('Origin', ORIGIN)
        .set('Cookie', cookie.split(';')[0])
        .send({ email: z.email, password: PASSWORD })
        .expect(200);
      expect(await prisma.cartItem.count({ where: { cartId: aCart.id } })).toBe(1);
      expect(await prisma.cart.count({ where: { customerId: z.id } })).toBe(0);
      // A guest replaying the cookie of an account's cart sees nothing.
      const view = await browser().agent.get('/api/cart').set('Cookie', cookie.split(';')[0]).expect(200);
      expect((view.body as CartView).lines).toEqual([]);
    });
  });

  describe('checkout with a customer', () => {
    it('prefill: 204 for a guest; contact and addresses (default first) for a session', async () => {
      await browser().agent.get('/api/checkout/prefill').expect(204);
      const c = await newCustomer();
      const b = browser();
      await b.signIn(c.email);
      await b.write('post', '/api/account/addresses', address()).expect(201);
      const def = (await b.write('post', '/api/account/addresses', address({ isDefault: true })).expect(201))
        .body as CustomerAddressView;
      const res = await b.agent.get('/api/checkout/prefill').expect(200);
      expect(res.headers['cache-control']).toBe('no-store');
      const prefill = res.body as CheckoutPrefill;
      expect(prefill.contact).toEqual({ fullName: c.fullName, phone: c.phone, email: c.email });
      expect(prefill.addresses.map((a) => a.id)[0]).toBe(def.id);
      expect(prefill.addresses).toHaveLength(2);
    });

    it('marketing consent at checkout is stored on the order with its time; unchecked by default', async () => {
      const guest = browser();
      await guest.add(lamp, 1);
      const unchecked = await orderOf(await guest.checkout());
      expect(unchecked).toMatchObject({ marketingConsent: false, marketingConsentAt: null, customerId: null });

      const other = browser();
      await other.add(lamp, 1);
      const checked = await orderOf(await other.checkout({ marketingConsent: true }));
      expect(checked.marketingConsent).toBe(true);
      expect(checked.marketingConsentAt).toBeInstanceOf(Date);
      const bad = await (async () => {
        const b = browser();
        await b.add(lamp, 1);
        return b.checkout({ marketingConsent: 'yes' as unknown as boolean });
      })();
      expect(bad.status).toBe(400);
    });
  });
});
