import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { AdminOrderDetail, OrderView } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { availableStock } from './../src/cart/available-stock.js';
import { configureApp } from './../src/configure-app.js';
import { FulfillmentMode, OrderShippingMethod, OrderStatus, PaymentStatus } from './../src/generated/prisma/client.js';
import { sign } from './../src/payments/webhook-signature.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { adminBrowser, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const ORIGIN = 'http://localhost:4200';
const SECRET = process.env.PAYMENT_SANDBOX_SECRET ?? '';
const MINUTE = 60_000;

/** A calendar date in Israel, `days` from today, as YYYY-MM-DD. */
const israelDate = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(
    new Date(Date.now() + days * 24 * 60 * MINUTE),
  );

// Status moves, delivery slots and the customer cancel of unpaid orders (spec §4.1, §4.2, ADM-04, SRV-01).
describe('Order lifecycle (e2e, ADM-04, SRV-01)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  /** orders.view only. */
  let seller: AdminBrowser;
  let variantId: number;

  const http = () => request(app.getHttpServer() as App);
  const cleanup = () =>
    prisma.order.deleteMany({ where: { contact: { path: ['fullName'], string_starts_with: 'ZZ' } } });

  const makeOrder = async (key: string, status: OrderStatus, opts: { variant?: boolean; reserved?: boolean } = {}) =>
    prisma.order.create({
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
        reservedUntil: new Date(Date.now() + (opts.reserved === false ? -MINUTE : 20 * MINUTE)),
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
              lineTotal: 100_000,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'sandbox',
              transactionId: `sbx_zz_${key}`,
              status: status === OrderStatus.PAID ? PaymentStatus.SUCCEEDED : PaymentStatus.PENDING,
              amount: 115_000,
            },
          ],
        },
      },
    });
  const move = (b: AdminBrowser, number: number, body: object) => b.post(`/orders/${number}/status`, body);
  const slot = (date = israelDate(3), windowFrom = '09:00', windowTo = '13:00') => ({ date, windowFrom, windowTo });
  const cancel = (number: number, token: string) =>
    http().post(`/api/orders/${number}/cancel?t=${token}`).set('Origin', ORIGIN);
  const view = async (number: number, token: string) =>
    (await http().get(`/api/orders/${number}?t=${token}`).expect(200)).body as OrderView;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: seller } = await signInOwnerAnd(app, 'store_seller'));
    variantId = (
      await prisma.variant.findFirstOrThrow({
        where: { fulfillment: FulfillmentMode.IN_STOCK, stock: { gte: 5 } },
        select: { id: true },
      })
    ).id;
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('advances paid → processing → delivery_scheduled → shipped → delivered with events, slot and audit', async () => {
    const order = await makeOrder('flow', OrderStatus.PAID);
    const n = order.number;
    expect((await move(owner, n, { to: 'processing' }).expect(201)).body.status).toBe('processing');
    const scheduled = (await move(owner, n, { to: 'delivery_scheduled', slot: slot() }).expect(201))
      .body as AdminOrderDetail;
    expect(scheduled.status).toBe('delivery_scheduled');
    expect(scheduled.deliverySlot).toEqual({
      date: israelDate(3),
      windowFrom: '09:00',
      windowTo: '13:00',
      state: 'proposed',
    });
    expect(scheduled.nextStatuses).toEqual(['shipped', 'delivered']);
    expect(scheduled.canCancel).toBe(true);
    await move(owner, n, { to: 'shipped' }).expect(201);
    const done = (await move(owner, n, { to: 'delivered' }).expect(201)).body as AdminOrderDetail;
    expect(done.status).toBe('delivered');
    expect(done.nextStatuses).toEqual([]);
    expect(done.canCancel).toBe(false);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.deliveredAt).not.toBeNull();
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
    expect(events.map((e) => [e.fromStatus, e.toStatus, e.actorType])).toEqual([
      ['PAID', 'PROCESSING', 'ADMIN'],
      ['PROCESSING', 'DELIVERY_SCHEDULED', 'ADMIN'],
      ['DELIVERY_SCHEDULED', 'SHIPPED', 'ADMIN'],
      ['SHIPPED', 'DELIVERED', 'ADMIN'],
    ]);
    expect(events.every((e) => e.actorAdminId !== null)).toBe(true);
    expect(done.statusEvents.map((e) => e.toStatus)).toEqual([
      'processing',
      'delivery_scheduled',
      'shipped',
      'delivered',
    ]);
    const audit = await prisma.auditLog.findMany({
      where: { action: 'order.status', entityId: String(n) },
      orderBy: { id: 'asc' },
    });
    expect(audit).toHaveLength(4);
    expect(audit[0]).toMatchObject({
      entityType: 'order',
      before: { status: 'paid' },
      after: { status: 'processing' },
    });
  });

  it('may skip forward, never backward or sideways; delivered is final', async () => {
    const order = await makeOrder('skip', OrderStatus.PAID);
    await move(owner, order.number, { to: 'shipped' }).expect(201);
    for (const to of ['processing', 'paid', 'shipped', 'cancelled', 'pending_payment', 'expired']) {
      const res = await move(owner, order.number, { to }).expect(409);
      expect(res.body.code, to).toBe('invalid_transition');
    }
    await move(owner, order.number, { to: 'delivered' }).expect(201);
    await move(owner, order.number, { to: 'shipped' }).expect(409);
    await move(owner, order.number, { to: 'bogus' }).expect(400);
    await move(owner, order.number, {}).expect(400);
    const pending = await makeOrder('pending-move', OrderStatus.PENDING_PAYMENT);
    expect((await move(owner, pending.number, { to: 'processing' }).expect(409)).body.code).toBe('invalid_transition');
    await move(owner, 999_999_999, { to: 'processing' }).expect(404);
    expect(await prisma.orderStatusEvent.count({ where: { orderId: pending.id } })).toBe(0);
  });

  it('delivery_scheduled needs a valid slot (400 slot.date / slot.window) and changes nothing without it', async () => {
    const order = await makeOrder('slot-bad', OrderStatus.PROCESSING);
    const n = order.number;
    const field = async (body: object) => (await move(owner, n, body).expect(400)).body.field;
    expect(await field({ to: 'delivery_scheduled' })).toBe('slot.date');
    expect(await field({ to: 'delivery_scheduled', slot: slot(israelDate(-1)) })).toBe('slot.date');
    expect(await field({ to: 'delivery_scheduled', slot: slot('2026-02-30') })).toBe('slot.date');
    expect(await field({ to: 'delivery_scheduled', slot: slot('tomorrow') })).toBe('slot.date');
    expect(await field({ to: 'delivery_scheduled', slot: slot(israelDate(2), '13:00', '09:00') })).toBe('slot.window');
    expect(await field({ to: 'delivery_scheduled', slot: slot(israelDate(2), '10:00', '10:00') })).toBe('slot.window');
    expect(await field({ to: 'delivery_scheduled', slot: slot(israelDate(2), '9:00', '13:00') })).toBe('slot.window');
    expect(await field({ to: 'delivery_scheduled', slot: slot(israelDate(2), '09:00', '24:30') })).toBe('slot.window');
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(row.status).toBe(OrderStatus.PROCESSING);
    expect(await prisma.deliverySlot.count({ where: { orderId: order.id } })).toBe(0);
    // Today is allowed.
    await move(owner, n, { to: 'delivery_scheduled', slot: slot(israelDate(0)) }).expect(201);
  });

  it('a new slot supersedes the old one (the order stays delivery_scheduled)', async () => {
    const order = await makeOrder('slot-new', OrderStatus.PROCESSING);
    const n = order.number;
    await move(owner, n, { to: 'delivery_scheduled', slot: slot(israelDate(3), '09:00', '13:00') }).expect(201);
    // Same status: only a slot change, allowed while the order is delivery_scheduled.
    const res = (
      await move(owner, n, {
        to: 'delivery_scheduled',
        slot: { ...slot(israelDate(4), '14:00', '18:00'), note: 'נא להתקשר' },
      }).expect(201)
    ).body as AdminOrderDetail;
    expect(res.status).toBe('delivery_scheduled');
    expect(res.deliverySlot).toMatchObject({
      date: israelDate(4),
      windowFrom: '14:00',
      windowTo: '18:00',
      state: 'proposed',
    });
    const slots = await prisma.deliverySlot.findMany({ where: { orderId: order.id }, orderBy: { id: 'asc' } });
    expect(slots.map((s) => s.state)).toEqual(['SUPERSEDED', 'PROPOSED']);
    expect(slots[1].note).toBe('נא להתקשר');
    // The customer's view shows the live slot.
    expect((await view(n, order.publicToken)).deliverySlot).toMatchObject({ date: israelDate(4), windowFrom: '14:00' });
    // A later status keeps the slot; only delivery_scheduled → delivery_scheduled with a slot is a slot change.
    await move(owner, n, { to: 'shipped' }).expect(201);
    await move(owner, n, { to: 'delivery_scheduled', slot: slot() }).expect(409);
  });

  it('needs orders.manage: a view-only user gets 403, no session 401', async () => {
    const order = await makeOrder('perm', OrderStatus.PAID);
    await move(seller, order.number, { to: 'processing' }).expect(403);
    await adminBrowser(app).post(`/orders/${order.number}/status`, { to: 'processing' }).expect(401);
    await http()
      .post(`/api/admin/orders/${order.number}/status`)
      .send({ to: 'processing' })
      .expect((r) => expect([401, 403]).toContain(r.status));
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAID);
  });

  it('the customer view carries the Hebrew label, canCancel and refundedTotal', async () => {
    const pending = await makeOrder('view-pending', OrderStatus.PENDING_PAYMENT);
    const paid = await makeOrder('view-paid', OrderStatus.PAID);
    expect(await view(pending.number, pending.publicToken)).toMatchObject({
      status: 'pending_payment',
      statusLabelHe: 'ממתינה לתשלום',
      canCancel: true,
      refundedTotal: 0,
      deliverySlot: null,
    });
    expect(await view(paid.number, paid.publicToken)).toMatchObject({
      status: 'paid',
      statusLabelHe: 'שולמה',
      canCancel: false,
    });
    const stale = await makeOrder('view-stale', OrderStatus.PENDING_PAYMENT, { reserved: false });
    expect(await view(stale.number, stale.publicToken)).toMatchObject({ status: 'expired', canCancel: false });
  });

  it('customer cancel of a pending order: cancelled, stock available again, payments cancelled, event written', async () => {
    const order = await makeOrder('cancel', OrderStatus.PENDING_PAYMENT, { variant: true });
    const before = (await availableStock(prisma, [variantId])).get(variantId)!;
    const stock = (await prisma.variant.findUniqueOrThrow({ where: { id: variantId } })).stock;
    expect(before).toBe(stock - 2);

    const res = await cancel(order.number, order.publicToken).expect(201);
    expect(res.body).toMatchObject({ status: 'cancelled', statusLabelHe: 'בוטלה', canCancel: false });
    expect((await availableStock(prisma, [variantId])).get(variantId)).toBe(stock);
    expect((await prisma.variant.findUniqueOrThrow({ where: { id: variantId } })).stock).toBe(stock);

    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(row.status).toBe(OrderStatus.CANCELLED);
    expect(row.cancelledAt).not.toBeNull();
    expect(row.payments.map((p) => p.status)).toEqual([PaymentStatus.CANCELLED]);
    const events = await prisma.orderStatusEvent.findMany({ where: { orderId: order.id } });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      fromStatus: 'PENDING_PAYMENT',
      toStatus: 'CANCELLED',
      actorType: 'CUSTOMER',
      actorAdminId: null,
    });
    // Cancelling again is refused.
    expect((await cancel(order.number, order.publicToken).expect(409)).body.code).toBe('invalid_transition');
  });

  it('customer cancel is refused for paid and expired orders (409), unknown token 404, missing token 404', async () => {
    const paid = await makeOrder('cancel-paid', OrderStatus.PAID);
    expect((await cancel(paid.number, paid.publicToken).expect(409)).body.code).toBe('invalid_transition');
    expect((await prisma.order.findUniqueOrThrow({ where: { id: paid.id } })).status).toBe(OrderStatus.PAID);
    const stale = await makeOrder('cancel-stale', OrderStatus.PENDING_PAYMENT, { reserved: false });
    await cancel(stale.number, stale.publicToken).expect(409);

    const pending = await makeOrder('cancel-token', OrderStatus.PENDING_PAYMENT);
    await cancel(pending.number, 'wrong').expect(404);
    await http().post(`/api/orders/${pending.number}/cancel`).set('Origin', ORIGIN).expect(404);
    await cancel(999_999_999, 'x').expect(404);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: pending.id } })).status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );
    // The storefront origin is required.
    await http().post(`/api/orders/${pending.number}/cancel?t=${pending.publicToken}`).expect(403);
  });

  it('webhook success first, then customer cancel → 409 (the order is paid)', async () => {
    const order = await makeOrder('race', OrderStatus.PENDING_PAYMENT);
    const payload = { transactionId: 'sbx_zz_race', status: 'succeeded', amount: order.total, installments: 1 };
    const body = JSON.stringify(payload);
    await http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', sign(body, SECRET))
      .send(body)
      .expect(200);
    expect((await cancel(order.number, order.publicToken).expect(409)).body.code).toBe('invalid_transition');
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { payments: true } });
    expect(row.status).toBe(OrderStatus.PAID);
    expect(row.payments[0].status).toBe(PaymentStatus.SUCCEEDED);
  });

  it('cancel is throttled per IP (bucket cancel)', async () => {
    const throttle = app.get(WriteThrottle);
    throttle.setLimit('cancel', 2);
    try {
      const order = await makeOrder('throttle', OrderStatus.PAID);
      await cancel(order.number, order.publicToken).expect(409);
      await cancel(order.number, order.publicToken).expect(409);
      await cancel(order.number, order.publicToken).expect(429);
    } finally {
      throttle.setLimit('cancel', 1000);
    }
  });

  // Delivery-date SMS and the confirmation link (spec §5.3, SHP-04).
  describe('delivery link', () => {
    const schedule = (n: number, date = israelDate(3)) =>
      move(owner, n, { to: 'delivery_scheduled', slot: slot(date) }).expect(201);
    const sendJobs = async () => {
      await app.get(OutboxService).runDue(100);
    };
    const smsLogs = (orderId: string) =>
      prisma.notificationLog.findMany({
        where: { orderId, template: 'delivery_slot' },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
    /** Token of the link in the last SMS of the order. */
    const tokenOf = async (orderId: string) => {
      const rows = await smsLogs(orderId);
      const match = /\/delivery\/([\w-]+)/.exec(rows[rows.length - 1].body ?? '');
      return match![1];
    };
    const delivery = (token: string) => http().get(`/api/delivery/${token}`);
    const answer = (token: string, body: object) =>
      http().post(`/api/delivery/${token}`).set('Origin', ORIGIN).send(body);
    const scheduledOrder = async (key: string) => {
      const order = await makeOrder(key, OrderStatus.PROCESSING);
      await schedule(order.number);
      await sendJobs();
      return order;
    };

    afterEach(async () => {
      await prisma.outboxJob.deleteMany({});
      await prisma.notificationLog.deleteMany({});
    });

    it('scheduling sends one SMS with a link; only the token hash is stored', async () => {
      const order = await scheduledOrder('dl-sms');
      const rows = await smsLogs(order.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ channel: 'SMS', status: 'SENT' });
      const token = await tokenOf(order.id);
      expect(rows[0].body).toContain(`http://localhost:4200/delivery/${token}`);
      expect(rows[0].body).toContain(`${order.number}`);
      const slotRow = await prisma.deliverySlot.findFirstOrThrow({ where: { orderId: order.id } });
      expect(slotRow.tokenHash).toMatch(/^[0-9a-f]{64}$/);
      expect(slotRow.tokenHash).not.toContain(token);
      const got = (await delivery(token).expect(200)).body;
      expect(got).toEqual({
        orderNumber: order.number,
        date: israelDate(3),
        windowFrom: '09:00',
        windowTo: '13:00',
        state: 'proposed',
      });
    });

    it('confirm: slot CONFIRMED, audit written, a second answer is 409 already_answered', async () => {
      const order = await scheduledOrder('dl-confirm');
      const token = await tokenOf(order.id);
      expect((await answer(token, { answer: 'confirm' }).expect(201)).body.state).toBe('confirmed');
      expect((await answer(token, { answer: 'change' }).expect(409)).body.code).toBe('already_answered');
      expect((await delivery(token).expect(200)).body.state).toBe('confirmed');
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.needsAttention).toBe(false);
      const audit = await prisma.auditLog.findFirst({
        where: { action: 'delivery.confirmed', entityId: String(order.number) },
      });
      expect(audit?.actorId).toBeNull();
      const detail = (await owner.get(`/orders/${order.number}`).expect(200)).body as AdminOrderDetail;
      expect(detail.deliverySlot?.state).toBe('confirmed');
    });

    it('change request: flags the order with the note, writes audit, no status change', async () => {
      const order = await scheduledOrder('dl-change');
      const token = await tokenOf(order.id);
      const res = await answer(token, { answer: 'change', note: '  רק אחרי הצהריים  ' }).expect(201);
      expect(res.body.state).toBe('change_requested');
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.status).toBe(OrderStatus.DELIVERY_SCHEDULED);
      expect(row.needsAttention).toBe(true);
      expect(row.attentionNote).toBe('הלקוח ביקש מועד אספקה אחר — רק אחרי הצהריים');
      expect(
        await prisma.auditLog.count({ where: { action: 'delivery.change_requested', entityId: String(order.number) } }),
      ).toBe(1);
      const detail = (await owner.get(`/orders/${order.number}`).expect(200)).body as AdminOrderDetail;
      expect(detail.deliverySlot?.state).toBe('change_requested');
      expect(detail.needsAttention).toBe(true);
    });

    it('a change request keeps an earlier attention note and stays within 500 characters', async () => {
      const order = await scheduledOrder('dl-keep');
      await prisma.order.update({
        where: { id: order.id },
        data: { needsAttention: true, attentionNote: 'החזר נכשל' },
      });
      const token = await tokenOf(order.id);
      await answer(token, { answer: 'change', note: 'ת'.repeat(500) }).expect(201);
      const note = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).attentionNote!;
      expect(note.startsWith('החזר נכשל · הלקוח ביקש מועד אספקה אחר — ת')).toBe(true);
      expect(note.length).toBeLessThanOrEqual(500);
    });

    it('change without a note uses the bare text; a bad answer or a long note is 400', async () => {
      const order = await scheduledOrder('dl-bare');
      const token = await tokenOf(order.id);
      await answer(token, { answer: 'maybe' }).expect(400);
      await answer(token, { answer: 'change', note: 'x'.repeat(501) }).expect(400);
      await answer(token, { answer: 'change' }).expect(201);
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).attentionNote).toBe(
        'הלקוח ביקש מועד אספקה אחר',
      );
    });

    it('unknown token 404; superseded slot 404; cancelled order 404; POST needs the storefront origin', async () => {
      await delivery('nope').expect(404);
      await answer('nope', { answer: 'confirm' }).expect(404);
      const order = await scheduledOrder('dl-old');
      const oldToken = await tokenOf(order.id);
      await http().post(`/api/delivery/${oldToken}`).send({ answer: 'confirm' }).expect(403);
      await schedule(order.number, israelDate(5));
      await delivery(oldToken).expect(404);
      await answer(oldToken, { answer: 'confirm' }).expect(404);
      await sendJobs();
      const newToken = await tokenOf(order.id);
      expect(newToken).not.toBe(oldToken);
      expect((await delivery(newToken).expect(200)).body.date).toBe(israelDate(5));
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
      await delivery(newToken).expect(404);
    });

    it('a job for a slot that is no longer proposed sends nothing', async () => {
      const order = await makeOrder('dl-skip', OrderStatus.PROCESSING);
      await schedule(order.number);
      await prisma.deliverySlot.updateMany({ where: { orderId: order.id }, data: { state: 'CONFIRMED' } });
      await sendJobs();
      expect(await smsLogs(order.id)).toHaveLength(0);
    });

    it('answers are throttled per IP (bucket delivery)', async () => {
      const throttle = app.get(WriteThrottle);
      throttle.setLimit('delivery', 2);
      try {
        await answer('nope', { answer: 'confirm' }).expect(404);
        await answer('nope', { answer: 'confirm' }).expect(404);
        await answer('nope', { answer: 'confirm' }).expect(429);
      } finally {
        throttle.setLimit('delivery', 1000);
      }
    });
  });
});
