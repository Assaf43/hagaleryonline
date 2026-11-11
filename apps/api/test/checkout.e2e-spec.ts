import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type {
  AdminProduct,
  AdminProductInput,
  CartView,
  CheckoutRequest,
  CheckoutResponse,
  OrderView,
  SandboxCompleteResponse,
  SandboxPaymentView,
  ShippingQuote,
} from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { AdminUsersService } from './../src/auth/admin-users.service.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { FulfillmentMode, OrderStatus, PaymentStatus } from './../src/generated/prisma/client.js';
import { sign } from './../src/payments/webhook-signature.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, resetAdminData, type AdminBrowser } from './admin-session.js';

const ORIGIN = 'http://localhost:4200';
/** תל אביב - יפו: in no zone. */
const LOCALITY = 5000;
/** Set for the e2e run in vitest.config.e2e.ts. */
const SECRET = process.env.PAYMENT_SANDBOX_SECRET ?? '';
const MINUTE = 60_000;

// Runs against the e2e test database (migrated and seeded by test/e2e-global-setup.ts). The API listens on an
// ephemeral port and API_INTERNAL_URL points at it, so the sandbox "complete" endpoint delivers its signed webhook
// over real HTTP, through the same code path a real provider would use (spec §5.3).
describe('Checkout, orders and payment (e2e, CHK-01–04, CHK-06, CHK-09, CHK-10, NFR-10)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let productId: number;
  /** One unit in stock. */
  let last: number;
  /** Plenty in stock. */
  let plenty: number;
  /** Two in stock. */
  let few: number;
  /** One unit, for the concurrent race. */
  let race: number;
  /** Becomes hidden between cart and checkout. */
  let soonHidden: number;
  /** One unit, sold twice by a late payment. */
  let oversell: number;
  /** Made to order: no stock count. */
  let madeToOrder: number;
  /** Never ordered. */
  let spare: number;
  let savedSettings: { additionalItemPercent: number; floorSurcharge: number; floorSurchargeFrom: number } | null;
  let localityName: string;

  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    return {
      agent,
      cart: async () => (await agent.get('/api/cart').expect(200)).body as CartView,
      add: (variantId: number, quantity: number) =>
        agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity }).expect(200),
      /**
       * POST /api/checkout. Like the storefront, it sends the total on screen (cart subtotal + the chosen method's
       * quote) unless the body already has `expectedTotal`; when nothing can be quoted it sends 0, so the server's
       * own refusal (empty cart, shortage, unknown locality…) is what the test sees. A promise of the response, with
       * `.expect(status)` like supertest's.
       */
      checkout: (body: unknown) => {
        const sent = (async (): Promise<request.Response> =>
          agent
            .post('/api/checkout')
            .set('Origin', ORIGIN)
            .send(await withExpectedTotal(agent, body)))();
        return Object.assign(sent, {
          expect: async (status: number) => {
            const res = await sent;
            expect(res.status, JSON.stringify(res.body)).toBe(status);
            return res;
          },
        });
      },
      quote: async (floor: number, hasElevator: boolean) =>
        (
          await agent
            .post('/api/shipping/quote')
            .set('Origin', ORIGIN)
            .send({ localityId: LOCALITY, floor, hasElevator })
            .expect(200)
        ).body as ShippingQuote,
    };
  };
  const http = () => request(app.getHttpServer() as App);
  const withExpectedTotal = async (agent: ReturnType<typeof request.agent>, body: unknown): Promise<object> => {
    const req = body as Record<string, unknown>;
    if (typeof req !== 'object' || req === null || 'expectedTotal' in req) return req;
    const address = (req.address ?? {}) as Partial<CheckoutRequest['address']>;
    const [cart, quote] = await Promise.all([
      agent.get('/api/cart'),
      agent
        .post('/api/shipping/quote')
        .set('Origin', ORIGIN)
        .send({ localityId: address.localityId, floor: address.floor, hasElevator: address.hasElevator }),
    ]);
    const option =
      quote.status === 200 ? (quote.body as ShippingQuote).methods.find((m) => m.method === req.method) : undefined;
    const view = cart.body as CartView;
    const expectedTotal =
      option && cart.status === 200 ? view.subtotal - (view.discount?.amount ?? 0) + option.total : 0;
    return { ...req, expectedTotal };
  };
  const checkoutBody = (patch: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
    contact: { fullName: 'דנה כהן', phone: '050-1234567', email: 'dana@example.test' },
    address: {
      localityId: LOCALITY,
      street: 'הרצל',
      houseNumber: '12',
      apartment: '4',
      floor: 4,
      hasElevator: false,
      notes: null,
    },
    method: 'curbside',
    acceptTerms: true,
    ...patch,
  });
  const txOf = (res: request.Response) => {
    const { redirectUrl } = res.body as CheckoutResponse;
    const match = new RegExp(`^${ORIGIN}/pay/sandbox/([\\w-]+)$`).exec(redirectUrl);
    if (!match) throw new Error(`unexpected redirect ${redirectUrl}`);
    return match[1];
  };
  const orderOfTx = async (transactionId: string) =>
    (
      await prisma.payment.findUniqueOrThrow({
        where: { transactionId },
        include: { order: { include: { items: true } } },
      })
    ).order;
  /** Checks out the browser's cart and returns the order with its payment's transaction id. */
  const placeOrder = async (b: ReturnType<typeof browser>, body = checkoutBody()) => {
    const tx = txOf(await b.checkout(body).expect(201));
    return { tx, order: await orderOfTx(tx) };
  };
  const complete = (tx: string, outcome: string, installments = 1) =>
    http().post(`/api/payments/sandbox/${tx}/complete`).set('Origin', ORIGIN).send({ outcome, installments });
  const webhook = (payload: object, signature?: string) => {
    const body = JSON.stringify(payload);
    const req = http().post('/api/payments/webhook').set('Content-Type', 'application/json');
    return (signature === undefined ? req : req.set('x-sandbox-signature', signature)).send(body);
  };
  const signed = (payload: object) => webhook(payload, sign(JSON.stringify(payload), SECRET));
  const viewOf = async (number: number, token: string) =>
    (await http().get(`/api/orders/${number}?t=${token}`).expect(200)).body as OrderView;
  const stockOf = async (id: number) => (await prisma.variant.findUniqueOrThrow({ where: { id } })).stock;
  /** What a new customer may put in the cart now (available stock). */
  const limitOf = async (variantId: number) => {
    const res = await browser().agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity: 1 });
    if (res.status === 409) return 0;
    expect(res.status).toBe(200);
    return (res.body as CartView).lines[0].maxQuantity;
  };
  const invalidateCatalog = () => app.get(CacheStore).invalidate('catalog:');

  const cleanup = async () => {
    await prisma.order.deleteMany();
    await prisma.cart.deleteMany();
    await resetAdminData(prisma);
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-chk' } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    await cleanup();

    owner = await acceptAndSignIn(
      app,
      { email: 'owner@example.test', password: 'olive sofa sunset window' },
      await app.get(AdminUsersService).createSuperAdmin('owner@example.test', 'בעלת העסק'),
    );

    const category = await prisma.category.create({
      data: {
        slug: 'zz-chk',
        nameHe: 'בדיקת קופה',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const size = { widthCm: 200, depthCm: 90, heightCm: 80, leadTimeDays: 7 };
    const product = await prisma.product.create({
      data: {
        slug: 'zz-chk-sofa',
        modelName: 'ZZCHK',
        nameHe: 'ספת קופה',
        categoryId: category.id,
        variants: {
          create: [
            { sku: 'ZZCHK-LAST', price: 100_000, stock: 1, sortOrder: 0, ...size },
            { sku: 'ZZCHK-PLENTY', price: 50_000, stock: 50, sortOrder: 1, ...size },
            { sku: 'ZZCHK-FEW', price: 70_000, stock: 2, sortOrder: 2, ...size },
            { sku: 'ZZCHK-RACE', price: 80_000, stock: 1, sortOrder: 3, ...size },
            { sku: 'ZZCHK-HIDE', price: 60_000, stock: 5, sortOrder: 4, ...size },
            { sku: 'ZZCHK-OVER', price: 90_000, stock: 1, sortOrder: 5, ...size },
            {
              sku: 'ZZCHK-MTO',
              price: 120_000,
              stock: 0,
              fulfillment: FulfillmentMode.MADE_TO_ORDER,
              sortOrder: 6,
              ...size,
            },
            { sku: 'ZZCHK-SPARE', price: 10_000, stock: 3, sortOrder: 7, ...size },
          ],
        },
      },
      include: { variants: { orderBy: { sortOrder: 'asc' } } },
    });
    productId = product.id;
    [last, plenty, few, race, soonHidden, oversell, madeToOrder, spare] = product.variants.map((v) => v.id);

    savedSettings = await prisma.shippingSettings.findUnique({ where: { id: 1 } });
    const settings = { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 };
    await prisma.shippingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
    localityName = (await prisma.locality.findUniqueOrThrow({ where: { id: LOCALITY } })).nameHe;
    await invalidateCatalog();
  });

  afterAll(async () => {
    await cleanup();
    if (savedSettings) await prisma.shippingSettings.update({ where: { id: 1 }, data: savedSettings });
    else await prisma.shippingSettings.deleteMany();
    await invalidateCatalog();
    await app.close();
  });

  // 2 × 40,000 delivery, the second unit at 50% → 60,000. Full service adds 2 × 30,000 assembly and floor 4
  // without an elevator from floor 2 = 3 × 5,000.
  const CURBSIDE_2 = 60_000;
  const FULL_SERVICE_2 = CURBSIDE_2 + 60_000 + 15_000;

  it('checkout creates a pending order with a snapshot, a payment and a 20-minute reservation', async () => {
    const b = browser();
    await b.add(plenty, 2);
    const before = await limitOf(plenty);
    const started = Date.now();
    const { tx, order } = await placeOrder(b);

    expect(order.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(order.number).toBeGreaterThanOrEqual(100_001);
    expect(order.publicToken).toMatch(/^[\w-]{40,}$/);
    expect(order.items).toEqual([
      expect.objectContaining({
        variantId: plenty,
        sku: 'ZZCHK-PLENTY',
        modelName: 'ZZCHK',
        nameHe: 'ספת קופה',
        unitPrice: 50_000,
        quantity: 2,
        lineTotal: 100_000,
      }),
    ]);
    expect(order).toMatchObject({
      subtotal: 100_000,
      discount: 0,
      shippingTotal: CURBSIDE_2,
      total: 100_000 + CURBSIDE_2,
      method: 'CURBSIDE',
      paymentProvider: 'sandbox',
      shippingProvider: 'manual',
      contact: { fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.test' },
      address: {
        localityId: LOCALITY,
        localityNameHe: localityName,
        street: 'הרצל',
        houseNumber: '12',
        apartment: '4',
        floor: 4,
        hasElevator: false,
        notes: null,
      },
      deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 7 },
    });
    expect(order.cartId).not.toBeNull();
    const reservedMs = order.reservedUntil.getTime() - started;
    expect(reservedMs).toBeGreaterThan(19 * MINUTE);
    expect(reservedMs).toBeLessThanOrEqual(20 * MINUTE + 5_000);

    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: tx } });
    expect(payment).toMatchObject({ provider: 'sandbox', status: PaymentStatus.PENDING, amount: order.total });

    // Stock is only held, not taken: the column is unchanged, a new customer may take 2 fewer.
    expect(await stockOf(plenty)).toBe(50);
    expect(await limitOf(plenty)).toBe(before - 2);

    // The cart keeps its lines until the payment succeeds.
    expect((await b.cart()).lines.map((l) => l.quantity)).toEqual([2]);

    const view = await viewOf(order.number, order.publicToken);
    expect(view).toMatchObject({
      number: order.number,
      status: 'pending_payment',
      subtotal: 100_000,
      shippingTotal: CURBSIDE_2,
      total: 100_000 + CURBSIDE_2,
      method: 'curbside',
      canRetryPayment: false,
      address: { localityNameHe: localityName, street: 'הרצל', floor: 4 },
    });
    expect(view.lines).toEqual([
      {
        variantId: plenty,
        sku: 'ZZCHK-PLENTY',
        modelName: 'ZZCHK',
        nameHe: 'ספת קופה',
        optionLabels: [],
        unitPrice: 50_000,
        quantity: 2,
        lineTotal: 100_000,
      },
    ]);
    // The token is the only key: the view never shows the customer's contact details.
    expect(JSON.stringify(view)).not.toContain('dana@example.test');
  });

  it('both shipping methods produce the totals of the shipping quote', async () => {
    for (const [method, expected] of [
      ['curbside', CURBSIDE_2],
      ['full_service', FULL_SERVICE_2],
    ] as const) {
      const b = browser();
      await b.add(plenty, 2);
      const quoted = (await b.quote(4, false)).methods.find((m) => m.method === method)!;
      expect(quoted.total).toBe(expected);
      const { order } = await placeOrder(b, checkoutBody({ method }));
      expect(order.shippingTotal).toBe(expected);
      expect(order.shippingLines).toEqual(quoted.lines);
      expect(order.total).toBe(100_000 + expected);
      expect(order.method).toBe(method === 'curbside' ? 'CURBSIDE' : 'FULL_SERVICE');
    }
  });

  it('a second cart cannot take the reserved last unit (409 with the line and its new limit)', async () => {
    const a = browser();
    const b = browser();
    await a.add(last, 1);
    await b.add(last, 1);
    await placeOrder(a);
    const res = await b.checkout(checkoutBody()).expect(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'insufficient_stock', variantId: last, available: 0 });
    expect(await prisma.orderItem.count({ where: { variantId: last } })).toBe(1);
  });

  it('after reservedUntil passes the unit is available again and the order reads expired', async () => {
    const order = await prisma.order.findFirstOrThrow({ where: { items: { some: { variantId: last } } } });
    await prisma.order.update({ where: { id: order.id }, data: { reservedUntil: new Date(Date.now() - 1_000) } });

    expect(await limitOf(last)).toBe(1);
    const view = await viewOf(order.number, order.publicToken);
    expect(view.status).toBe('expired');
    expect(view.canRetryPayment).toBe(true);

    // Someone else takes the freed unit; the expired order can no longer be retried.
    const c = browser();
    await c.add(last, 1);
    await placeOrder(c);
    expect((await viewOf(order.number, order.publicToken)).canRetryPayment).toBe(false);
    const retry = await http()
      .post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(409);
    expect(retry.body).toEqual({ statusCode: 409, code: 'insufficient_stock', variantId: last, available: 0 });
  });

  it('two customers racing for the last unit: exactly one order is created', async () => {
    const a = browser();
    const b = browser();
    await a.add(race, 1);
    await b.add(race, 1);
    const results = await Promise.all([a.checkout(checkoutBody()), b.checkout(checkoutBody())]);
    expect(results.map((r) => r.status).sort((x, y) => x - y)).toEqual([201, 409]);
    expect(results.find((r) => r.status === 409)!.body).toMatchObject({ variantId: race, available: 0 });
    expect(await prisma.orderItem.count({ where: { variantId: race } })).toBe(1);
  });

  it('sandbox success → paid, stock down, cart emptied; duplicate and late failure change nothing', async () => {
    const b = browser();
    await b.add(plenty, 3);
    const stock = await stockOf(plenty);
    const { tx, order } = await placeOrder(b);

    const page = (await http().get(`/api/payments/sandbox/${tx}`).expect(200)).body as SandboxPaymentView;
    expect(page).toEqual({ transactionId: tx, orderNumber: order.number, amount: order.total, status: 'pending' });

    const res = await complete(tx, 'success', 3).expect(200);
    expect(res.body as SandboxCompleteResponse).toEqual({
      confirmationUrl: `/order/${order.number}?t=${order.publicToken}`,
    });
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(paid.status).toBe(OrderStatus.PAID);
    expect(paid.payments).toEqual([
      expect.objectContaining({ status: PaymentStatus.SUCCEEDED, installments: 3, amount: order.total }),
    ]);
    expect(await stockOf(plenty)).toBe(stock - 3);
    expect((await b.cart()).lines).toEqual([]);
    expect((await viewOf(order.number, order.publicToken)).status).toBe('paid');

    // The same webhook again (through the sandbox and directly): stock goes down once.
    await complete(tx, 'success', 3).expect(200);
    await signed({ transactionId: tx, status: 'succeeded', amount: order.total, installments: 3 }).expect(200);
    expect(await stockOf(plenty)).toBe(stock - 3);

    // A failure after the success: the paid order never goes back.
    await complete(tx, 'failure').expect(200);
    await complete(tx, 'cancel').expect(200);
    const still = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(still.status).toBe(OrderStatus.PAID);
    expect(still.payments[0].status).toBe(PaymentStatus.SUCCEEDED);
    expect(await stockOf(plenty)).toBe(stock - 3);
    await http()
      .post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(409)
      .expect((r) => expect(r.body.code).toBe('not_retryable'));
  });

  it('refuses a webhook with a bad or missing signature (401) and changes nothing', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const { tx, order } = await placeOrder(b);
    const payload = { transactionId: tx, status: 'succeeded', amount: order.total, installments: 1 };
    const body = JSON.stringify(payload);

    await webhook(payload, sign(body, 'not-the-secret')).expect(401);
    await webhook(payload).expect(401);
    await webhook(payload, 'f'.repeat(64)).expect(401);
    // Signed, then tampered with.
    await http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', sign(body, SECRET))
      .send(body.replace(`"amount":${order.total}`, '"amount":1'))
      .expect(401);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );
  });

  it('a success with the wrong amount flags the payment and leaves the order pending', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const stock = await stockOf(plenty);
    const { tx, order } = await placeOrder(b);
    await signed({ transactionId: tx, status: 'succeeded', amount: order.total - 1, installments: 1 }).expect(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(after.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(after.payments[0]).toMatchObject({ rawStatus: 'amount_mismatch' });
    expect(after.payments[0].status).not.toBe(PaymentStatus.SUCCEEDED);
    expect(await stockOf(plenty)).toBe(stock);
    expect((await b.cart()).lines).toHaveLength(1);
  });

  it('a webhook for an unknown transaction is 404; a signed but malformed payload is 400', async () => {
    await signed({ transactionId: 'sbx_unknown', status: 'succeeded', amount: 1, installments: 1 }).expect(404);
    await signed({ transactionId: 'sbx_unknown', status: 'maybe', amount: 1 }).expect(400);
  });

  it('failure → payment_failed, the reservation is released, and retry makes a new payment page', async () => {
    const b = browser();
    await b.add(few, 2);
    const { tx, order } = await placeOrder(b);
    expect(await limitOf(few)).toBe(0);

    await complete(tx, 'failure').expect(200);
    let after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(after.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(after.payments[0].status).toBe(PaymentStatus.FAILED);
    expect(await limitOf(few)).toBe(2);
    const view = await viewOf(order.number, order.publicToken);
    expect(view).toMatchObject({ status: 'payment_failed', canRetryPayment: true });

    // Retry needs the storefront origin and the right token.
    await http().post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`).expect(403);
    await http().post(`/api/orders/${order.number}/retry-payment?t=wrong`).set('Origin', ORIGIN).expect(404);
    const started = Date.now();
    const retry = await http()
      .post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(201);
    const tx2 = txOf(retry);
    expect(tx2).not.toBe(tx);
    after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(after.status).toBe(OrderStatus.PENDING_PAYMENT);
    expect(after.reservedUntil.getTime() - started).toBeGreaterThan(19 * MINUTE);
    expect(after.payments).toHaveLength(2);
    expect(await limitOf(few)).toBe(0);
    // A second retry while the new payment page is open is refused.
    await http()
      .post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(409);

    // A late failure of the first attempt does not touch the order that is waiting for the second.
    await signed({ transactionId: tx, status: 'cancelled', amount: order.total, installments: 1 }).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );

    const stock = await stockOf(few);
    await complete(tx2, 'success', 12).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAID);
    expect(await stockOf(few)).toBe(stock - 2);
  });

  it('cancel → payment_failed with a cancelled payment', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const { tx, order } = await placeOrder(b);
    await complete(tx, 'cancel').expect(200);
    const after = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(after.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(after.payments[0].status).toBe(PaymentStatus.CANCELLED);
  });

  it('price or visibility changed between cart and checkout → the order uses the current price and visible lines', async () => {
    const b = browser();
    await b.add(plenty, 1);
    await b.add(soonHidden, 1);
    await prisma.variant.update({ where: { id: plenty }, data: { price: 55_000 } });
    await prisma.variant.update({ where: { id: soonHidden }, data: { active: false } });
    await invalidateCatalog();
    try {
      const { tx, order } = await placeOrder(b);
      expect(order.items.map((i) => [i.variantId, i.unitPrice, i.quantity, i.lineTotal])).toEqual([
        [plenty, 55_000, 1, 55_000],
      ]);
      expect(order.subtotal).toBe(55_000);
      // One unit: delivery 40,000 only.
      expect(order.total).toBe(55_000 + 40_000);
      expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: tx } })).amount).toBe(order.total);
    } finally {
      await prisma.variant.update({ where: { id: plenty }, data: { price: 50_000 } });
      await prisma.variant.update({ where: { id: soonHidden }, data: { active: true } });
      await invalidateCatalog();
    }
  });

  it('a new checkout from the same cart replaces its earlier pending order (no self-blocking)', async () => {
    await prisma.variant.update({ where: { id: few }, data: { stock: 2 } });
    const b = browser();
    await b.add(few, 2);
    const first = await placeOrder(b);
    // Back from the payment page: the customer's own pending order does not make their lines look sold out (a new
    // checkout releases it), so the total they see is the one charged. Other customers still see them reserved.
    const own = (await b.cart()).lines[0];
    expect(own).toMatchObject({ variantId: few, quantity: 2, available: true, maxQuantity: 2 });
    expect(await limitOf(few)).toBe(0);
    const second = await placeOrder(b, checkoutBody({ method: 'full_service' }));
    expect(second.order.id).not.toBe(first.order.id);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).status).toBe(OrderStatus.EXPIRED);
    expect(await limitOf(few)).toBe(0);

    // The replaced order cannot be retried: the newer one is the one to pay.
    expect((await viewOf(first.order.number, first.order.publicToken)).canRetryPayment).toBe(false);
    const retry = await http()
      .post(`/api/orders/${first.order.number}/retry-payment?t=${first.order.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(409);
    expect(retry.body.code).toBe('superseded');

    // If its old page is paid anyway, it is honored, but the cart keeps the lines the newer order needs.
    await complete(first.tx, 'success').expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).status).toBe(OrderStatus.PAID);
    expect((await b.cart()).lines.map((l) => l.variantId)).toEqual([few]);
    // Both orders of the cart could now be paid: the payment is flagged for staff.
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: first.tx } })).rawStatus).toBe(
      'superseded_paid',
    );
    await complete(second.tx, 'cancel').expect(200);
  });

  it('paying a replaced order after its replacement was dropped: not flagged, and the cart is emptied', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const first = await placeOrder(b);
    const second = await placeOrder(b);
    // The customer drops the newer order (cancels its payment) and pays the older page instead.
    await complete(second.tx, 'cancel').expect(200);
    await complete(first.tx, 'success').expect(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: first.tx } });
    expect(payment.rawStatus).not.toBe('superseded_paid');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: first.order.id } })).status).toBe(OrderStatus.PAID);
    expect((await b.cart()).lines).toEqual([]);
  });

  it('concurrent duplicate webhooks take the stock once', async () => {
    const b = browser();
    await b.add(plenty, 2);
    const stock = await stockOf(plenty);
    const { tx, order } = await placeOrder(b);
    const payload = { transactionId: tx, status: 'succeeded', amount: order.total, installments: 1 };
    const results = await Promise.all([signed(payload), signed(payload), signed(payload)]);
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(await stockOf(plenty)).toBe(stock - 2);
  });

  it('a late success after the unit was sold to someone else: paid, stock floored at 0, order flagged', async () => {
    const a = browser();
    await a.add(oversell, 1);
    const late = await placeOrder(a);
    await prisma.order.update({ where: { id: late.order.id }, data: { reservedUntil: new Date(Date.now() - 1_000) } });
    const c = browser();
    await c.add(oversell, 1);
    const other = await placeOrder(c);
    await complete(other.tx, 'success').expect(200);
    expect(await stockOf(oversell)).toBe(0);

    await complete(late.tx, 'success').expect(200);
    const paid = await prisma.order.findUniqueOrThrow({ where: { id: late.order.id } });
    expect(paid).toMatchObject({ status: OrderStatus.PAID, stockShortage: true });
    expect(await stockOf(oversell)).toBe(0);
    expect((await viewOf(late.order.number, late.order.publicToken)).stockShortage).toBe(true);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: other.order.id } })).stockShortage).toBe(false);
  });

  it('a made-to-order line does not touch the stock column', async () => {
    const b = browser();
    await b.add(madeToOrder, 2);
    const { tx, order } = await placeOrder(b);
    await complete(tx, 'success').expect(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: OrderStatus.PAID,
      stockShortage: false,
    });
    expect(await stockOf(madeToOrder)).toBe(0);
  });

  it('expectedTotal: a different total is refused with 409 price_changed and nothing is created or reserved', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const orders = await prisma.order.count();
    const available = await limitOf(plenty);
    // One unit: 50,000 + delivery 40,000.
    const res = await b.checkout({ ...checkoutBody(), expectedTotal: 90_000 - 1 }).expect(409);
    expect(res.body).toEqual({ statusCode: 409, code: 'price_changed', total: 90_000 });
    expect(await prisma.order.count()).toBe(orders);
    expect(await limitOf(plenty)).toBe(available);
    await b.checkout({ ...checkoutBody(), expectedTotal: -5 }).expect(400);
    await b.checkout({ ...checkoutBody(), expectedTotal: '90000' }).expect(400);
    // Without the total the customer saw, nothing is charged (an old client or a script cannot skip the check).
    const missing = await b.agent.post('/api/checkout').set('Origin', ORIGIN).send(checkoutBody()).expect(400);
    expect(missing.body).toEqual({ statusCode: 400, code: 'invalid_input' });
    expect(await prisma.order.count()).toBe(orders);
    expect(await limitOf(plenty)).toBe(available);
    const ok = await b.checkout({ ...checkoutBody(), expectedTotal: 90_000 }).expect(201);
    expect((await orderOfTx(txOf(ok))).total).toBe(90_000);
  });

  it('a price change after the customer saw the total is caught (price_changed), not charged silently', async () => {
    const b = browser();
    await b.add(plenty, 1);
    await prisma.variant.update({ where: { id: plenty }, data: { price: 55_000 } });
    await invalidateCatalog();
    try {
      const res = await b.checkout({ ...checkoutBody(), expectedTotal: 90_000 }).expect(409);
      expect(res.body).toMatchObject({ code: 'price_changed', total: 95_000 });
    } finally {
      await prisma.variant.update({ where: { id: plenty }, data: { price: 50_000 } });
      await invalidateCatalog();
    }
  });

  it('public writes are rate limited per IP (429 too_many_requests with Retry-After)', async () => {
    const throttle = app.get(WriteThrottle);
    throttle.setLimit('checkout', 2);
    throttle.setLimit('retry', 1);
    try {
      const empty = () =>
        http()
          .post('/api/checkout')
          .set('Origin', ORIGIN)
          .send({ ...checkoutBody(), expectedTotal: 0 });
      await empty().expect(409);
      await empty().expect(409);
      const limited = await empty().expect(429);
      expect(limited.body).toMatchObject({ statusCode: 429, code: 'too_many_requests' });
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);

      const retry = () => http().post('/api/orders/100001/retry-payment?t=wrong').set('Origin', ORIGIN);
      await retry().expect(404);
      await retry().expect(429);

      // Behind the proxy each customer has a bucket of their own (the client IP comes from X-Forwarded-For).
      throttle.setLimit('checkout', 1);
      const from = (ip: string) => empty().set('X-Forwarded-For', ip);
      await from('203.0.113.7').expect(409);
      await from('203.0.113.7').expect(429);
      await from('203.0.113.8').expect(409);
    } finally {
      throttle.setLimit('checkout', 100_000);
      throttle.setLimit('retry', 100_000);
    }
  });

  it('a failure webhook followed by a success webhook on the same payment ends paid, stock taken once', async () => {
    const b = browser();
    await b.add(plenty, 2);
    const stock = await stockOf(plenty);
    const { tx, order } = await placeOrder(b);
    await signed({ transactionId: tx, status: 'failed', amount: order.total, installments: 1 }).expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAYMENT_FAILED);
    await signed({ transactionId: tx, status: 'succeeded', amount: order.total, installments: 2 }).expect(200);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).toMatchObject({
      status: OrderStatus.PAID,
      stockShortage: false,
    });
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: tx } })).status).toBe(
      PaymentStatus.SUCCEEDED,
    );
    expect(await stockOf(plenty)).toBe(stock - 2);
    // Repeating the success changes nothing.
    await signed({ transactionId: tx, status: 'succeeded', amount: order.total, installments: 2 }).expect(200);
    expect(await stockOf(plenty)).toBe(stock - 2);
  });

  it('when the payment row cannot be recorded the order fails at once and holds no stock', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const available = await limitOf(plenty);
    const spy = vi.spyOn(prisma.payment, 'create').mockRejectedValueOnce(new Error('db down'));
    try {
      const res = await b.checkout(checkoutBody()).expect(502);
      expect(res.body).toMatchObject({ code: 'payment_unavailable' });
    } finally {
      spy.mockRestore();
    }
    const order = await prisma.order.findFirstOrThrow({
      where: { items: { some: { variantId: plenty } } },
      orderBy: { number: 'desc' },
    });
    expect(order.status).toBe(OrderStatus.PAYMENT_FAILED);
    expect(await limitOf(plenty)).toBe(available);
  });

  it('a retry and a new checkout of the same cart at once never leave two orders holding stock', async () => {
    for (let round = 0; round < 4; round++) {
      const b = browser();
      await b.add(plenty, 1);
      const { tx, order } = await placeOrder(b);
      await complete(tx, 'failure').expect(200);
      const [retry, again] = await Promise.all([
        http().post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`).set('Origin', ORIGIN),
        b.checkout(checkoutBody()),
      ]);
      expect([retry.status, again.status]).not.toContain(500);
      expect(again.status).toBe(201);
      expect([201, 409]).toContain(retry.status);
      const pending = await prisma.order.count({
        where: { cartId: order.cartId!, status: OrderStatus.PENDING_PAYMENT },
      });
      expect(pending).toBe(1);
    }
  });

  it('refuses invalid input, a missing origin and an empty cart', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const bad = checkoutBody();
    bad.contact.phone = '03-1234567';
    expect((await b.checkout(bad).expect(400)).body).toEqual({
      statusCode: 400,
      code: 'invalid_field',
      field: 'contact.phone',
      messageHe: 'יש להזין מספר טלפון נייד תקין, למשל 050-1234567',
    });
    const unknownLocality = checkoutBody();
    unknownLocality.address.localityId = 99_999_999;
    expect((await b.checkout(unknownLocality).expect(400)).body).toMatchObject({ field: 'address.localityId' });
    await b.agent.post('/api/checkout').send(checkoutBody()).expect(403);
    expect((await browser().checkout(checkoutBody()).expect(409)).body.code).toBe('empty_cart');
  });

  it('the sandbox endpoints need the storefront origin and a known transaction', async () => {
    await http()
      .post('/api/payments/sandbox/sbx_nope/complete')
      .send({ outcome: 'success', installments: 1 })
      .expect(403);
    await complete('sbx_nope', 'success').expect(404);
    await http().get('/api/payments/sandbox/sbx_nope').expect(404);
    const b = browser();
    await b.add(plenty, 1);
    const { tx } = await placeOrder(b);
    await complete(tx, 'maybe').expect(400);
    await complete(tx, 'success', 13).expect(400);
    await complete(tx, 'success', 0).expect(400);
  });

  it('the confirmation needs the right token (404 otherwise)', async () => {
    const order = await prisma.order.findFirstOrThrow();
    await http().get(`/api/orders/${order.number}?t=wrong-token`).expect(404);
    await http().get(`/api/orders/${order.number}`).expect(404);
    await http().get(`/api/orders/999999?t=${order.publicToken}`).expect(404);
    await http().get(`/api/orders/abc?t=${order.publicToken}`).expect(404);
  });

  it('a product save and a checkout at once both finish (no deadlock)', async () => {
    const b = browser();
    await b.add(plenty, 1);
    const current = (await owner.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    const { id: _id, images: _i, createdAt: _c, updatedAt, relations: _r, ...rest } = current;
    const input: AdminProductInput = {
      ...rest,
      active: false,
      variants: current.variants.map((v, i) => ({ ...v, widthCm: 150 + i })),
      expectedUpdatedAt: updatedAt,
    };
    const [saved, placed] = await Promise.all([
      owner.put(`/catalog/products/${productId}`, input),
      b.checkout(checkoutBody()),
    ]);
    expect(saved.status).toBe(200);
    expect([201, 409]).toContain(placed.status);
  });

  it('saving a product cannot remove a variant that was ordered (409); an unordered one can go', async () => {
    const forSave = (p: AdminProduct, variants: AdminProduct['variants']): AdminProductInput => {
      const { id: _id, images: _i, createdAt: _c, updatedAt, relations: _r, ...rest } = p;
      // Distinct widths: the test variants share their options, and two identical rows cannot be saved.
      const distinct = variants.map((v, i) => ({ ...v, widthCm: 150 + i }));
      return { ...rest, active: false, variants: distinct, expectedUpdatedAt: updatedAt };
    };
    let current = (await owner.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    const lastIndex = current.variants.findIndex((v) => v.id === last);
    const res = await owner
      .put(
        `/catalog/products/${productId}`,
        forSave(
          current,
          current.variants.filter((v) => v.id !== last),
        ),
      )
      .expect(409);
    expect(res.body).toMatchObject({
      code: 'in_use',
      field: `variants.${lastIndex}`,
      messageHe: 'לווריאנט יש הזמנות. אפשר רק לכבות אותו.',
    });
    expect(await prisma.variant.count({ where: { id: last } })).toBe(1);

    current = (await owner.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    await owner
      .put(
        `/catalog/products/${productId}`,
        forSave(
          current,
          current.variants.filter((v) => v.id !== spare),
        ),
      )
      .expect(200);
    expect(await prisma.variant.count({ where: { id: spare } })).toBe(0);
  });

  it('the Super Admin cannot delete a product that was ordered (409)', async () => {
    const res = await owner.delete(`/catalog/products/${productId}`).expect(409);
    expect(res.body).toMatchObject({ messageHe: 'למוצר יש הזמנות. אפשר רק להסתיר אותו.' });
    expect(await prisma.product.count({ where: { id: productId } })).toBe(1);
  });
});
