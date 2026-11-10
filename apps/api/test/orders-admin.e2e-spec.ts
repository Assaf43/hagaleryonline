import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AdminOrderDetail, AdminOrderPage, OneTimeLink, ProvidersStatus } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { OrderShippingMethod, OrderStatus, PaymentStatus } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, adminBrowser, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

// Read-only admin orders and providers (spec §5.5, ADM-13). Orders are created straight in the database.
describe('Admin orders and providers (e2e, ADM-13)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  /** customer_service: orders.view and orders.manage. */
  let viewer: AdminBrowser;
  /** content_editor: no order permissions. */
  let editor: AdminBrowser;
  let seller: AdminBrowser;
  const numbers: Record<string, number> = {};

  const cleanup = () =>
    prisma.order.deleteMany({ where: { contact: { path: ['fullName'], string_starts_with: 'ZZ' } } });

  const makeOrder = async (key: string, status: OrderStatus, opts: { reservedUntil?: Date; createdAt?: Date } = {}) => {
    const paid = status === OrderStatus.PAID;
    const order = await prisma.order.create({
      data: {
        publicToken: `zz-token-${key}`,
        status,
        contact: { fullName: `ZZ ${key}`, phone: '0501234567', email: 'zz@example.test' },
        address: {
          localityId: 5000,
          localityNameHe: 'תל אביב - יפו',
          street: 'הרצל',
          houseNumber: '1',
          apartment: null,
          floor: 2,
          hasElevator: true,
          notes: null,
        },
        method: OrderShippingMethod.CURBSIDE,
        shippingTotal: 15_000,
        shippingLines: [{ labelHe: 'משלוח', amount: 15_000 }],
        subtotal: 100_000,
        total: 115_000,
        deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 3 },
        paymentProvider: 'sandbox',
        shippingProvider: 'manual',
        reservedUntil: opts.reservedUntil ?? new Date(Date.now() + 20 * MINUTE),
        createdAt: opts.createdAt,
        stockShortage: paid,
        items: {
          create: [
            {
              sku: `ZZ-${key}`,
              modelName: 'ZZ ALBA',
              nameHe: 'ספה',
              optionLabels: ['בז'],
              unitPrice: 50_000,
              quantity: 2,
              lineTotal: 100_000,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'sandbox',
              transactionId: `sbx_zz_${key}`,
              status: paid ? PaymentStatus.SUCCEEDED : PaymentStatus.PENDING,
              installments: paid ? 3 : null,
              amount: 115_000,
            },
          ],
        },
      },
    });
    numbers[key] = order.number;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: viewer } = await signInOwnerAnd(app, 'customer_service'));
    const sellerUser = { email: 'seller@example.test', password: 'maple window quiet harbor' };
    const created = await owner
      .post('/users', { email: sellerUser.email, name: 'מוכר', template: 'store_seller' })
      .expect(201);
    seller = await acceptAndSignIn(app, sellerUser, created.body.invite as OneTimeLink);
    const editorUser = { email: 'editor@example.test', password: 'pebble garden lantern ocean' };
    const made = await owner
      .post('/users', { email: editorUser.email, name: 'עורך', template: 'content_editor' })
      .expect(201);
    editor = await acceptAndSignIn(app, editorUser, made.body.invite as OneTimeLink);

    await makeOrder('paid', OrderStatus.PAID, { createdAt: new Date(Date.now() - 3 * DAY) });
    await makeOrder('pending', OrderStatus.PENDING_PAYMENT, { createdAt: new Date(Date.now() - 2 * DAY) });
    await makeOrder('failed', OrderStatus.PAYMENT_FAILED, { createdAt: new Date(Date.now() - DAY) });
    await makeOrder('stale', OrderStatus.PENDING_PAYMENT, {
      reservedUntil: new Date(Date.now() - MINUTE),
      createdAt: new Date(),
    });
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('needs a session and orders.view', async () => {
    await adminBrowser(app).get('/orders').expect(401);
    await adminBrowser(app).get('/providers').expect(401);
    await editor.get('/orders').expect(403);
    await editor.get(`/orders/${numbers.paid}`).expect(403);
    await viewer.get('/orders').expect(200);
    await seller.get('/orders').expect(200);
  });

  it('lists newest first with the row fields and 30 per page', async () => {
    const page = (await viewer.get('/orders').expect(200)).body as AdminOrderPage;
    expect(page.pageSize).toBe(30);
    expect(page.page).toBe(1);
    const mine = page.items.filter((i) => i.customerName.startsWith('ZZ'));
    expect(mine.map((i) => i.customerName)).toEqual(['ZZ stale', 'ZZ failed', 'ZZ pending', 'ZZ paid']);
    expect(mine[3]).toEqual({
      number: numbers.paid,
      createdAt: expect.any(String),
      customerName: 'ZZ paid',
      phone: '0501234567',
      total: 115_000,
      status: 'paid',
      itemCount: 2,
    });
  });

  it('filters by status; a pending order past its reservation counts as expired', async () => {
    const names = async (status: string) =>
      ((await viewer.get(`/orders?status=${status}`).expect(200)).body as AdminOrderPage).items
        .map((i) => i.customerName)
        .filter((n) => n.startsWith('ZZ'));
    expect(await names('paid')).toEqual(['ZZ paid']);
    expect(await names('pending_payment')).toEqual(['ZZ pending']);
    expect(await names('payment_failed')).toEqual(['ZZ failed']);
    expect(await names('expired')).toEqual(['ZZ stale']);
    await viewer.get('/orders?status=bogus').expect(400);
  });

  it('pages: page 2 and an invalid page', async () => {
    const all = (await viewer.get('/orders').expect(200)).body as AdminOrderPage;
    const second = (await viewer.get('/orders?page=2').expect(200)).body as AdminOrderPage;
    expect(second.page).toBe(2);
    expect(second.total).toBe(all.total);
    expect(second.items.length).toBe(Math.max(0, Math.min(30, all.total - 30)));
    await viewer.get('/orders?page=0').expect(400);
  });

  it('shows one order in full, with its payments and no card data or token', async () => {
    const d = (await viewer.get(`/orders/${numbers.paid}`).expect(200)).body as AdminOrderDetail;
    expect(d).toMatchObject({
      number: numbers.paid,
      status: 'paid',
      contact: { fullName: 'ZZ paid', phone: '0501234567', email: 'zz@example.test' },
      address: { localityNameHe: 'תל אביב - יפו', street: 'הרצל', floor: 2 },
      method: 'curbside',
      shippingTotal: 15_000,
      subtotal: 100_000,
      total: 115_000,
      deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 3 },
      stockShortage: true,
      paymentProvider: 'sandbox',
      shippingProvider: 'manual',
    });
    expect(d.lines).toEqual([expect.objectContaining({ modelName: 'ZZ ALBA', quantity: 2, lineTotal: 100_000 })]);
    expect(d.payments).toEqual([
      expect.objectContaining({
        provider: 'sandbox',
        transactionId: 'sbx_zz_paid',
        status: 'succeeded',
        installments: 3,
        amount: 115_000,
      }),
    ]);
    expect(JSON.stringify(d)).not.toMatch(/publicToken|zz-token/);
    const stale = (await viewer.get(`/orders/${numbers.stale}`).expect(200)).body as AdminOrderDetail;
    expect(stale.status).toBe('expired');
  });

  it('answers 404 for an unknown or malformed number', async () => {
    await viewer.get('/orders/999999999').expect(404);
    await viewer.get('/orders/abc').expect(404);
  });

  it('shows the providers to the Super Admin and to orders.manage, not to orders.view alone', async () => {
    const status = (await owner.get('/providers').expect(200)).body as ProvidersStatus;
    expect(status).toEqual({ payment: { code: 'sandbox', testMode: true }, shipping: { code: 'manual' } });
    await viewer.get('/providers').expect(200);
    await seller.get('/providers').expect(403);
    await editor.get('/providers').expect(403);
  });
});
