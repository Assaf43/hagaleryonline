import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { AdminOrderDetail } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { FulfillmentMode, OrderShippingMethod, OrderStatus, PaymentStatus } from './../src/generated/prisma/client.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { sign } from './../src/payments/webhook-signature.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const ORIGIN = 'http://localhost:4200';
const SECRET = process.env.PAYMENT_SANDBOX_SECRET ?? '';
const MINUTE = 60_000;
const TOTAL = 100_000;
const NO_ORDER = '00000000-0000-4000-8000-000000000000';

// Refunds through the payment provider and the staff cancel (spec §4.3, §4.2, decisions 73-74, ADM-04).
describe('Refunds and staff cancel (e2e, ADM-04)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  /** customer_service: orders.manage but not orders.cancel. */
  let service: AdminBrowser;
  let variantId: number;
  let initialStock: number;

  const http = () => request(app.getHttpServer() as App);
  const cleanup = async () => {
    await prisma.order.deleteMany({ where: { contact: { path: ['fullName'], string_starts_with: 'ZZ' } } });
    await prisma.cart.deleteMany({ where: { tokenHash: { startsWith: 'zz-' } } });
  };
  const stock = async () => (await prisma.variant.findUniqueOrThrow({ where: { id: variantId } })).stock;

  const makeOrder = (key: string, status: OrderStatus, opts: { variant?: boolean; cartId?: string } = {}) =>
    prisma.order.create({
      data: {
        publicToken: `zz-token-${key}`,
        status,
        cartId: opts.cartId,
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
        shippingTotal: 0,
        shippingLines: [],
        subtotal: TOTAL,
        total: TOTAL,
        deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 3 },
        paymentProvider: 'sandbox',
        shippingProvider: 'manual',
        reservedUntil: new Date(Date.now() + 20 * MINUTE),
        items: {
          create: [
            {
              variantId: opts.variant ? variantId : null,
              sku: `ZZ-${key}`,
              modelName: 'ZZ ALBA',
              nameHe: 'ספה',
              optionLabels: ['בז'],
              unitPrice: 50_000,
              quantity: 2,
              lineTotal: TOTAL,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'sandbox',
              transactionId: `sbx_zz_${key}`,
              status: status === OrderStatus.PENDING_PAYMENT ? PaymentStatus.PENDING : PaymentStatus.SUCCEEDED,
              amount: TOTAL,
            },
          ],
        },
      },
    });
  const detail = async (number: number) => (await owner.get(`/orders/${number}`).expect(200)).body as AdminOrderDetail;
  const cancel = (b: AdminBrowser, number: number, body: object) => b.post(`/orders/${number}/cancel`, body);
  const refund = (b: AdminBrowser, number: number, body: object) => b.post(`/orders/${number}/refunds`, body);
  const retry = (b: AdminBrowser, number: number, id: string) => b.post(`/orders/${number}/refunds/${id}/retry`);
  /** A second payment page of the order, still open (e.g. a retry started in another tab). */
  const addPendingPayment = (orderId: string, transactionId: string) =>
    prisma.payment.create({ data: { orderId, provider: 'sandbox', transactionId, amount: TOTAL } });
  const ownerId = async () =>
    (await prisma.adminUser.findUniqueOrThrow({ where: { email: 'owner@example.test' }, select: { id: true } })).id;
  const customerCancel = (order: { number: number; publicToken: string }) =>
    http().post(`/api/orders/${order.number}/cancel?t=${order.publicToken}`).set('Origin', ORIGIN).expect(201);
  const webhook = (transactionId: string, amount: number, status = 'succeeded') => {
    const body = JSON.stringify({ transactionId, status, amount, installments: 1 });
    return http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', sign(body, SECRET))
      .send(body);
  };

  /** The late-payment refund is an outbox job (decision 83); the worker is off in e2e, so the tests run it. */
  const runJobs = () => app.get(OutboxService).runDue(100);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: service } = await signInOwnerAnd(app, 'customer_service'));
    const variant = await prisma.variant.findFirstOrThrow({
      where: { fulfillment: FulfillmentMode.IN_STOCK, stock: { gte: 5 } },
      select: { id: true, stock: true },
    });
    variantId = variant.id;
    initialStock = variant.stock;
  });

  afterAll(async () => {
    delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    await cleanup();
    await prisma.variant.update({ where: { id: variantId }, data: { stock: initialStock } });
    await resetAdminData(prisma);
    await app.close();
  });

  it('needs orders.cancel: customer service 403, Super Admin 403 until they opt in, then 200', async () => {
    const order = await makeOrder('perm', OrderStatus.PAID);
    const body = { refund: 'none', reason: 'בדיקה', restock: false };
    await cancel(service, order.number, body).expect(403);
    await refund(service, order.number, { amount: 1000, reason: 'בדיקה' }).expect(403);
    await retry(service, order.number, NO_ORDER).expect(403);
    await cancel(owner, order.number, body).expect(403);
    await refund(owner, order.number, { amount: 1000, reason: 'בדיקה' }).expect(403);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAID);

    await owner.put('/users/me/opt-in', { permissions: ['orders.cancel'] }).expect(200);
    await cancel(owner, order.number, body).expect(200);
  });

  it('full cancel of a paid order: refund succeeded, refundedTotal = total, CANCELLED, stock restored, audited', async () => {
    const order = await makeOrder('full', OrderStatus.PAID, { variant: true });
    const before = await stock();
    const res = await cancel(owner, order.number, { refund: 'full', reason: 'הלקוח ביקש', restock: true }).expect(200);
    const body = res.body as AdminOrderDetail;
    expect(body.status).toBe('cancelled');
    expect(body.refundedTotal).toBe(TOTAL);
    expect(body.refundable).toBe(0);
    expect(body.refunds).toHaveLength(1);
    expect(body.refunds[0]).toMatchObject({
      amount: TOTAL,
      status: 'succeeded',
      provider: 'sandbox',
      reason: 'הלקוח ביקש',
    });
    expect(await stock()).toBe(before + 2);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.refundedTotal).toBe(TOTAL);
    expect(row.cancelledAt).not.toBeNull();
    const refundRow = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(refundRow.idempotencyKey).toBe(`refund:${refundRow.id}`);
    expect(refundRow.providerRefundId).toBe(`sbx_rf_refund:${refundRow.id}`);
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.actorType])).toEqual([['PAID', 'CANCELLED', 'ADMIN']]);
    const audit = await prisma.auditLog.findMany({ where: { entityId: String(order.number) }, orderBy: { id: 'asc' } });
    expect(audit.map((a) => a.action)).toEqual(['order.cancel', 'order.refund']);
    // Cancelling again is refused.
    expect((await cancel(owner, order.number, { refund: 'none', reason: 'שוב' }).expect(409)).body.code).toBe(
      'invalid_transition',
    );
  });

  it('partial 30000 then 80000 on a 100000 order: the second is 409 refund_exceeds_paid', async () => {
    const order = await makeOrder('partial', OrderStatus.PAID);
    const first = await refund(owner, order.number, { amount: 30_000, reason: 'פיצוי' }).expect(200);
    expect((first.body as AdminOrderDetail).refundedTotal).toBe(30_000);
    expect((first.body as AdminOrderDetail).refundable).toBe(70_000);
    expect((await refund(owner, order.number, { amount: 80_000, reason: 'עוד' }).expect(409)).body.code).toBe(
      'refund_exceeds_paid',
    );
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.refundedTotal).toBe(30_000);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    // The status did not change: a refund is not a cancel.
    expect(row.status).toBe(OrderStatus.PAID);
  });

  it('partial cancel refunds the amount asked; the amount is validated before anything changes', async () => {
    const order = await makeOrder('cancel-partial', OrderStatus.PAID);
    const bad = async (body: object, status = 400) => (await cancel(owner, order.number, body).expect(status)).body;
    expect((await bad({ refund: 'partial', reason: 'בדיקה' })).field).toBe('amount');
    expect((await bad({ refund: 'partial', amount: 0, reason: 'בדיקה' })).field).toBe('amount');
    expect((await bad({ refund: 'partial', amount: 1.5, reason: 'בדיקה' })).field).toBe('amount');
    expect((await bad({ refund: 'partial', amount: '100', reason: 'בדיקה' })).field).toBe('amount');
    expect((await bad({ refund: 'partial', amount: TOTAL + 1, reason: 'בדיקה' }, 409)).code).toBe(
      'refund_exceeds_paid',
    );
    expect((await bad({ refund: 'sometimes', reason: 'בדיקה' })).field).toBe('refund');
    expect((await bad({ refund: 'none', reason: 'בדיקה', restock: 'yes' })).field).toBe('restock');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAID);

    const res = await cancel(owner, order.number, { refund: 'partial', amount: 40_000, reason: 'לפי התקנון' }).expect(
      200,
    );
    expect(res.body).toMatchObject({ status: 'cancelled', refundedTotal: 40_000, refundable: 60_000 });
  });

  it('cancel without a refund; restock:false leaves the stock, the default returns it', async () => {
    const keep = await makeOrder('none-keep', OrderStatus.PAID, { variant: true });
    const before = await stock();
    const res = await cancel(owner, keep.number, { refund: 'none', reason: 'הסחורה יצאה', restock: false }).expect(200);
    expect(res.body).toMatchObject({ status: 'cancelled', refundedTotal: 0, refunds: [] });
    expect(await stock()).toBe(before);
    expect(await prisma.refund.count({ where: { orderId: keep.id } })).toBe(0);

    const put = await makeOrder('none-restock', OrderStatus.PROCESSING, { variant: true });
    await cancel(owner, put.number, { refund: 'none', reason: 'ביטול בלי החזר' }).expect(200);
    expect(await stock()).toBe(before + 2);
  });

  it('cancel of an unpaid order: no refund possible, payments cancelled, no restock', async () => {
    const order = await makeOrder('unpaid', OrderStatus.PENDING_PAYMENT, { variant: true });
    const before = await stock();
    const bad = await cancel(owner, order.number, { refund: 'full', reason: 'בדיקה' }).expect(400);
    expect(bad.body.field).toBe('refund');
    await cancel(owner, order.number, { refund: 'none', reason: 'לקוח לא שילם' }).expect(200);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.payments.map((p) => p.status)).toEqual([PaymentStatus.CANCELLED]);
    expect(await stock()).toBe(before);
  });

  it('refund on a DELIVERED order without cancelling it', async () => {
    const order = await makeOrder('delivered', OrderStatus.DELIVERED);
    const res = await refund(owner, order.number, { amount: 25_000, reason: 'החזרה אושרה' }).expect(200);
    expect(res.body).toMatchObject({ status: 'delivered', refundedTotal: 25_000, refundable: 75_000 });
    // Cancel is not allowed from delivered.
    expect((await cancel(owner, order.number, { refund: 'none', reason: 'בדיקה' }).expect(409)).body.code).toBe(
      'invalid_transition',
    );
  });

  it('refund of an unpaid order is refused (nothing was paid); unknown order 404', async () => {
    const order = await makeOrder('refund-unpaid', OrderStatus.PENDING_PAYMENT);
    expect((await refund(owner, order.number, { amount: 1000, reason: 'בדיקה' }).expect(409)).body.code).toBe(
      'refund_exceeds_paid',
    );
    await refund(owner, 999_999_999, { amount: 1000, reason: 'בדיקה' }).expect(404);
  });

  it('validates reason (3-500 characters) and amount', async () => {
    const order = await makeOrder('validate', OrderStatus.PAID);
    const field = async (body: object) => (await refund(owner, order.number, body).expect(400)).body.field;
    expect(await field({ amount: 1000 })).toBe('reason');
    expect(await field({ amount: 1000, reason: '  ab ' })).toBe('reason');
    expect(await field({ amount: 1000, reason: 'x'.repeat(501) })).toBe('reason');
    expect(await field({ reason: 'בדיקה' })).toBe('amount');
    expect(await field({ amount: 0, reason: 'בדיקה' })).toBe('amount');
    expect(await field({ amount: -5, reason: 'בדיקה' })).toBe('amount');
    expect(await field({ amount: 10.5, reason: 'בדיקה' })).toBe('amount');
    const missing = await cancel(owner, order.number, { refund: 'none' }).expect(400);
    expect(missing.body.field).toBe('reason');
    await cancel(owner, order.number, { refund: 'none', reason: 'xx' }).expect(400);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(0);
  });

  it('a failing provider leaves the refund FAILED and the order flagged; retry once the flag is off succeeds once', async () => {
    const order = await makeOrder('fail', OrderStatus.PAID);
    process.env.PAYMENT_SANDBOX_FAIL_REFUNDS = 'true';
    let failed: AdminOrderDetail;
    try {
      failed = (await refund(owner, order.number, { amount: 20_000, reason: 'בדיקה' }).expect(200))
        .body as AdminOrderDetail;
    } finally {
      delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    }
    expect(failed.refunds).toHaveLength(1);
    expect(failed.refunds[0]).toMatchObject({ status: 'failed', amount: 20_000 });
    expect(failed.refunds[0].error).toBeTruthy();
    expect(failed.refundedTotal).toBe(0);
    expect(failed.needsAttention).toBe(true);
    expect(failed.attentionNote).toBeTruthy();
    expect(failed.attentionReasons).toContain('flagged');
    // A failed refund does not count against what can be refunded.
    expect(failed.refundable).toBe(TOTAL);
    const attention = (await owner.get('/orders?attention=true').expect(200)).body as { items: { number: number }[] };
    expect(attention.items.map((o) => o.number)).toContain(order.number);

    const id = failed.refunds[0].id;
    const key = (await prisma.refund.findUniqueOrThrow({ where: { id } })).idempotencyKey;
    const retried = (await retry(owner, order.number, id).expect(200)).body as AdminOrderDetail;
    expect(retried.refunds).toHaveLength(1);
    expect(retried.refunds[0]).toMatchObject({ id, status: 'succeeded', error: null });
    expect(retried.refundedTotal).toBe(20_000);
    expect(retried.needsAttention).toBe(false);
    expect((await prisma.refund.findUniqueOrThrow({ where: { id } })).idempotencyKey).toBe(key);

    // A succeeded refund cannot be retried (no second refund); an unknown id is 404.
    expect((await retry(owner, order.number, id).expect(409)).body.code).toBe('invalid_transition');
    await retry(owner, order.number, NO_ORDER).expect(404);
    await retry(owner, order.number, 'not-a-uuid').expect(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedTotal).toBe(20_000);
  });

  it('a stale PENDING refund (crash before the result) counts against refundable and can be retried', async () => {
    const order = await makeOrder('stale', OrderStatus.PAID);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const stale = await prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        amount: 60_000,
        reason: 'קרס',
        provider: 'sandbox',
        status: 'PENDING',
        idempotencyKey: 'refund:zz-stale-1',
        createdAt: new Date(Date.now() - 10 * MINUTE),
        updatedAt: new Date(Date.now() - 10 * MINUTE),
      },
    });
    expect((await detail(order.number)).refundable).toBe(40_000);
    expect((await refund(owner, order.number, { amount: 50_000, reason: 'בדיקה' }).expect(409)).body.code).toBe(
      'refund_exceeds_paid',
    );
    const fresh = await prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        amount: 10_000,
        reason: 'בתהליך',
        provider: 'sandbox',
        status: 'PENDING',
        idempotencyKey: 'refund:zz-fresh-1',
      },
    });
    // A pending refund that just started is still in flight: not retryable yet.
    expect((await retry(owner, order.number, fresh.id).expect(409)).body.code).toBe('invalid_transition');
    const retried = (await retry(owner, order.number, stale.id).expect(200)).body as AdminOrderDetail;
    expect(retried.refundedTotal).toBe(60_000);
    expect(retried.refunds.find((r) => r.id === stale.id)).toMatchObject({ status: 'succeeded' });
    expect((await prisma.refund.findUniqueOrThrow({ where: { id: stale.id } })).providerRefundId).toBe(
      'sbx_rf_refund:zz-stale-1',
    );
  });

  // Review Focus 1: the order row is locked, so two refunds cannot together exceed what was paid.
  it('two concurrent refunds of 60000 on a 100000 order: exactly one succeeds, one is 409', async () => {
    const order = await makeOrder('concurrent', OrderStatus.PAID);
    const body = { amount: 60_000, reason: 'במקביל' };
    const results = await Promise.all([refund(owner, order.number, body), refund(owner, order.number, body)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('refund_exceeds_paid');
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.refundedTotal).toBe(60_000);
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('two concurrent cancels of a paid order: one 200, one 409, stock restored once', async () => {
    const order = await makeOrder('concurrent-cancel', OrderStatus.PAID, { variant: true });
    const before = await stock();
    const body = { refund: 'full', reason: 'במקביל' };
    const results = await Promise.all([cancel(owner, order.number, body), cancel(owner, order.number, body)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(await stock()).toBe(before + 2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedTotal).toBe(TOTAL);
  });

  // Review Focus 2 (spec §4.2): a customer must never be charged for an order they cancelled.
  it('customer cancel, then a success webhook: payment recorded, full refund, flagged, stock unchanged', async () => {
    const order = await makeOrder('late', OrderStatus.PENDING_PAYMENT, { variant: true });
    const before = await stock();
    await customerCancel(order);

    await webhook('sbx_zz_late', TOTAL).expect(200);
    await runJobs();
    const row = await prisma.order.findUniqueOrThrow({
      where: { id: order.id },
      include: { payments: true, refunds: true },
    });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.payments[0].status).toBe(PaymentStatus.SUCCEEDED);
    expect(row.needsAttention).toBe(true);
    expect(row.attentionNote).toBe('תשלום התקבל אחרי ביטול — הוחזר');
    expect(row.refunds).toHaveLength(1);
    expect(row.refunds[0]).toMatchObject({
      amount: TOTAL,
      status: 'SUCCEEDED',
      reason: 'late_payment',
      adminUserId: null,
    });
    expect(row.refundedTotal).toBe(TOTAL);
    expect(await stock()).toBe(before);
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
    expect(events.map((e) => e.toStatus)).toEqual(['CANCELLED']);

    // The same webhook again changes nothing (no second refund).
    await webhook('sbx_zz_late', TOTAL).expect(200);
    await runJobs();
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect(await stock()).toBe(before);
    const shown = await detail(order.number);
    expect(shown.needsAttention).toBe(true);
    expect(shown.attentionNote).toBe('תשלום התקבל אחרי ביטול — הוחזר');
  });

  it('a late payment whose refund fails leaves the refund FAILED and the order flagged', async () => {
    const order = await makeOrder('late-fail', OrderStatus.PENDING_PAYMENT);
    await customerCancel(order);
    process.env.PAYMENT_SANDBOX_FAIL_REFUNDS = 'true';
    try {
      await webhook('sbx_zz_late-fail', TOTAL).expect(200);
      await runJobs();
    } finally {
      delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    }
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { refunds: true } });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.needsAttention).toBe(true);
    expect(row.refunds.map((r) => r.status)).toEqual(['FAILED']);
    expect(row.refundedTotal).toBe(0);
    const retried = (await retry(owner, order.number, row.refunds[0].id).expect(200)).body as AdminOrderDetail;
    expect(retried.refundedTotal).toBe(TOTAL);
    // The late-payment flag stays for staff even though the refund went through.
    expect(retried.needsAttention).toBe(true);
    expect(retried.attentionReasons).toContain('late_payment');
  });

  it('retry-payment on a cancelled order is refused (409 not_retryable)', async () => {
    const order = await makeOrder('retry-cancelled', OrderStatus.PENDING_PAYMENT);
    await customerCancel(order);
    const res = await http()
      .post(`/api/orders/${order.number}/retry-payment?t=${order.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(409);
    expect(res.body.code).toBe('not_retryable');
  });

  it('a failed or cancelled payment result after a cancel leaves the order CANCELLED (not retryable)', async () => {
    const retryPayment = (o: { number: number; publicToken: string }) =>
      http().post(`/api/orders/${o.number}/retry-payment?t=${o.publicToken}`).set('Origin', ORIGIN);

    const byStaff = await makeOrder('cancel-fail-admin', OrderStatus.PENDING_PAYMENT);
    await cancel(owner, byStaff.number, { refund: 'none', reason: 'בוטל על ידי הצוות' }).expect(200);
    await webhook('sbx_zz_cancel-fail-admin', TOTAL, 'failed').expect(200);
    await webhook('sbx_zz_cancel-fail-admin', TOTAL, 'cancelled').expect(200);
    const staffRow = await prisma.order.findUniqueOrThrow({ where: { id: byStaff.id }, include: { payments: true } });
    expect(staffRow.status).toBe(OrderStatus.CANCELLED);
    expect(staffRow.payments[0].status).toBe(PaymentStatus.CANCELLED);
    expect((await retryPayment(byStaff).expect(409)).body.code).toBe('not_retryable');

    const byCustomer = await makeOrder('cancel-fail-customer', OrderStatus.PENDING_PAYMENT);
    await customerCancel(byCustomer);
    // A payment opened by a retry that raced the cancel is still pending.
    await prisma.payment.updateMany({ where: { orderId: byCustomer.id }, data: { status: PaymentStatus.PENDING } });
    await webhook('sbx_zz_cancel-fail-customer', TOTAL, 'failed').expect(200);
    let customerRow = await prisma.order.findUniqueOrThrow({
      where: { id: byCustomer.id },
      include: { payments: true },
    });
    expect(customerRow.status).toBe(OrderStatus.CANCELLED);
    expect(customerRow.payments[0].status).toBe(PaymentStatus.FAILED);
    await webhook('sbx_zz_cancel-fail-customer', TOTAL, 'cancelled').expect(200);
    customerRow = await prisma.order.findUniqueOrThrow({ where: { id: byCustomer.id }, include: { payments: true } });
    expect(customerRow.status).toBe(OrderStatus.CANCELLED);
    expect((await retryPayment(byCustomer).expect(409)).body.code).toBe('not_retryable');
    expect(await prisma.orderStatusEvent.count({ where: { orderId: byCustomer.id } })).toBe(1);
  });

  it('the attention filter includes flagged orders; the detail carries refunds, note and slot', async () => {
    const order = await makeOrder('flagged', OrderStatus.PAID);
    await prisma.order.update({ where: { id: order.id }, data: { needsAttention: true, attentionNote: 'בדיקה' } });
    const page = (await owner.get('/orders?attention=true').expect(200)).body as {
      items: { number: number; needsAttention: boolean; attentionReasons: string[] }[];
    };
    const row = page.items.find((o) => o.number === order.number)!;
    expect(row).toMatchObject({ needsAttention: true, attentionReasons: ['flagged'] });
    const shown = await detail(order.number);
    expect(shown).toMatchObject({ needsAttention: true, attentionNote: 'בדיקה', refunds: [], refundable: TOTAL });
    expect(shown.deliverySlot).toBeNull();
  });

  // A paid order never changes, whatever step of the flow it reached (Phase 4 paid_twice, spec §4.1).
  it('a second successful payment on a shipped order: stays shipped, no stock taken, flagged paid_twice', async () => {
    const order = await makeOrder('twice-shipped', OrderStatus.PAID, { variant: true });
    await owner.post(`/orders/${order.number}/status`, { to: 'shipped' }).expect(201);
    await addPendingPayment(order.id, 'sbx_zz_twice-shipped-2');
    const before = await stock();

    await webhook('sbx_zz_twice-shipped-2', TOTAL).expect(200);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe(OrderStatus.SHIPPED);
    expect(row.stockShortage).toBe(false);
    expect(await stock()).toBe(before);
    const second = await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_twice-shipped-2' } });
    expect(second).toMatchObject({ status: PaymentStatus.SUCCEEDED, rawStatus: 'paid_twice' });
    expect((await detail(order.number)).attentionReasons).toContain('paid_twice');
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
    expect(events.map((e) => e.toStatus)).toEqual(['SHIPPED']);

    // The same holds for every status after paid.
    for (const status of [OrderStatus.PROCESSING, OrderStatus.DELIVERY_SCHEDULED, OrderStatus.DELIVERED]) {
      const other = await makeOrder(`twice-${status}`, status, { variant: true });
      await addPendingPayment(other.id, `sbx_zz_twice-${status}-2`);
      const stockBefore = await stock();
      await webhook(`sbx_zz_twice-${status}-2`, TOTAL).expect(200);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: other.id } })).status).toBe(status);
      expect(await stock()).toBe(stockBefore);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { transactionId: `sbx_zz_twice-${status}-2` } })).rawStatus,
      ).toBe('paid_twice');
    }
  });

  it('a newer order of the same cart already in processing: the older order payment is flagged superseded_paid', async () => {
    const cart = await prisma.cart.create({ data: { tokenHash: 'zz-superseded' } });
    await prisma.cartItem.create({ data: { cartId: cart.id, variantId, quantity: 2, unitPriceAtAdd: 50_000 } });
    const older = await makeOrder('superseded-old', OrderStatus.PENDING_PAYMENT, { variant: true, cartId: cart.id });
    const newer = await makeOrder('superseded-new', OrderStatus.PAID, { variant: true, cartId: cart.id });
    await owner.post(`/orders/${newer.number}/status`, { to: 'processing' }).expect(201);

    await webhook('sbx_zz_superseded-old', TOTAL).expect(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_superseded-old' } });
    expect(payment.rawStatus).toBe('superseded_paid');
    // The cart keeps its lines: they belong to the newer order's customer session.
    expect(await prisma.cartItem.count({ where: { cartId: cart.id } })).toBe(1);
    expect((await detail(older.number)).attentionReasons).toContain('superseded_paid');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: newer.id } })).status).toBe(OrderStatus.PROCESSING);
  });

  // The refund is capped at the order total (ledger ruling): a second charge after a full refund is refunded by hand.
  it('staff full-refund cancel, then a stray pending payment succeeds: manual-refund note, flagged, no second refund', async () => {
    const order = await makeOrder('stray', OrderStatus.PAID);
    await addPendingPayment(order.id, 'sbx_zz_stray-2');
    await cancel(owner, order.number, { refund: 'full', reason: 'הלקוח ביקש', restock: false }).expect(200);
    // Any staff cancel closes the order's open payment pages.
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_stray-2' } })).status).toBe(
      PaymentStatus.CANCELLED,
    );

    await webhook('sbx_zz_stray-2', TOTAL).expect(200);
    await runJobs();
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { refunds: true } });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.needsAttention).toBe(true);
    expect(row.attentionNote).toBe('תשלום נוסף אחרי ביטול — יש להחזיר ידנית מול ספק התשלום');
    expect(row.refunds).toHaveLength(1);
    expect(row.refundedTotal).toBe(TOTAL);
    const stray = await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_stray-2' } });
    expect(stray).toMatchObject({ status: PaymentStatus.SUCCEEDED, rawStatus: 'late_payment' });
    expect((await detail(order.number)).attentionReasons).toEqual(expect.arrayContaining(['flagged', 'late_payment']));
  });

  it('staff cancel of a paid order without a refund cancels its pending payments', async () => {
    const order = await makeOrder('paid-pending', OrderStatus.PAID);
    await addPendingPayment(order.id, 'sbx_zz_paid-pending-2');
    await cancel(owner, order.number, { refund: 'none', reason: 'בדיקה', restock: false }).expect(200);
    const payments = await prisma.payment.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(payments.map((p) => p.status)).toEqual([PaymentStatus.SUCCEEDED, PaymentStatus.CANCELLED]);
  });

  it('a retried refund names the retrying admin; the retry itself is audited with its actor', async () => {
    const order = await makeOrder('retry-actor', OrderStatus.PENDING_PAYMENT);
    await customerCancel(order);
    process.env.PAYMENT_SANDBOX_FAIL_REFUNDS = 'true';
    try {
      await webhook('sbx_zz_retry-actor', TOTAL).expect(200);
      await runJobs();
    } finally {
      delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    }
    const failed = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    expect(failed).toMatchObject({ status: 'FAILED', adminUserId: null });
    await retry(owner, order.number, failed.id).expect(200);

    const audit = await prisma.auditLog.findMany({ where: { entityId: String(order.number) }, orderBy: { id: 'asc' } });
    const id = await ownerId();
    expect(audit.map((a) => [a.action, a.actorId])).toEqual([
      ['order.late_payment', null],
      ['order.refund_failed', null],
      ['order.refund_retry', id],
      ['order.refund', id],
    ]);
  });
});
