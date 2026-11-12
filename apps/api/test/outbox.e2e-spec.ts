import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { AdminFailedJob, AdminOrderDetail, AdminOrderPage } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import {
  OrderShippingMethod,
  OrderStatus,
  OutboxJobState,
  PaymentStatus,
  RefundStatus,
} from './../src/generated/prisma/client.js';
import { OutboxService, type OutboxJobRow } from './../src/outbox/outbox.service.js';
import { sign } from './../src/payments/webhook-signature.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { deleteOrders, TEST_ORDERS } from './test-orders.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const ORIGIN = 'http://localhost:4200';
const SECRET = process.env.PAYMENT_SANDBOX_SECRET ?? '';
const MINUTE = 60_000;
const TOTAL = 100_000;
const NO_JOB = '00000000-0000-4000-8000-000000000000';

/** A calendar date in Israel, `days` from today, as YYYY-MM-DD. */
const israelDate = (days: number) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(
    new Date(Date.now() + days * 24 * 60 * MINUTE),
  );

// The durable outbox: jobs written in the transaction of the change, run by the worker with retries (spec §5.1,
// decision 83). The worker is off in e2e (OUTBOX_WORKER=off): the tests drive runDue() themselves.
describe('Outbox (e2e, decision 83)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let owner: AdminBrowser;
  /** content_editor: no orders.manage. */
  let editor: AdminBrowser;

  const http = () => request(app.getHttpServer() as App);
  const cleanup = async () => {
    await deleteOrders(prisma, TEST_ORDERS);
    await prisma.outboxJob.deleteMany({});
  };
  const jobs = (orderId: string) =>
    prisma.outboxJob.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { dedupeKey: 'asc' }] });
  const keys = async (orderId: string) => (await jobs(orderId)).map((j) => j.dedupeKey).sort();
  /** Makes every pending job due now (the backoff pushes them into the future). */
  const dueNow = () =>
    prisma.$executeRaw`UPDATE outbox_jobs SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE state = 'pending'`;

  const makeOrder = (key: string, status: OrderStatus) =>
    prisma.order.create({
      data: {
        publicToken: `zz-token-out-${key}`,
        status,
        contact: { fullName: `ZZ out ${key}`, phone: '0501234567', email: 'zz@example.test' },
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
              variantId: null,
              sku: `ZZ-OUT-${key}`,
              modelName: 'ZZ ALBA',
              nameHe: 'ספה',
              optionLabels: ['בז'],
              unitPrice: TOTAL,
              quantity: 1,
              lineTotal: TOTAL,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'sandbox',
              transactionId: `sbx_zz_out_${key}`,
              status: status === OrderStatus.PENDING_PAYMENT ? PaymentStatus.PENDING : PaymentStatus.SUCCEEDED,
              amount: TOTAL,
            },
          ],
        },
      },
    });
  const webhook = (transactionId: string, amount = TOTAL, status = 'succeeded') => {
    const body = JSON.stringify({ transactionId, status, amount, installments: 1 });
    return http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', sign(body, SECRET))
      .send(body);
  };
  const enqueue = (type: Parameters<OutboxService['enqueue']>[1]['type'], dedupeKey: string, orderId?: string) =>
    prisma.$transaction((tx) => outbox.enqueue(tx, { type, dedupeKey, payload: { key: dedupeKey }, orderId }));

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.init();
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    await owner.put('/users/me/opt-in', { permissions: ['orders.cancel'] }).expect(200);
  });

  beforeEach(async () => {
    // Only this file's jobs: other files leave pending jobs of types that get handlers in this file.
    await prisma.outboxJob.deleteMany({});
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('enqueue is idempotent: the same dedupe key twice leaves one row (the first)', async () => {
    await prisma.$transaction(async (tx) => {
      await outbox.enqueue(tx, { type: 'email.status', dedupeKey: 'zz:dup', payload: { n: 1 } });
      await outbox.enqueue(tx, { type: 'email.status', dedupeKey: 'zz:dup', payload: { n: 2 } });
    });
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, { type: 'email.status', dedupeKey: 'zz:dup', payload: { n: 3 } }),
    );
    const rows = await prisma.outboxJob.findMany({ where: { dedupeKey: 'zz:dup' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: 'email.status',
      state: OutboxJobState.PENDING,
      attempts: 0,
      payload: { n: 1 },
    });
  });

  it('a rolled-back transaction leaves no job', async () => {
    await expect(
      prisma.$transaction(async (tx) => {
        await outbox.enqueue(tx, { type: 'email.status', dedupeKey: 'zz:rollback', payload: {} });
        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');
    expect(await prisma.outboxJob.count({ where: { dedupeKey: 'zz:rollback' } })).toBe(0);
  });

  it('runs a due job once and marks it DONE; a type without a handler stays PENDING untouched', async () => {
    const seen: { payload: unknown; job: OutboxJobRow }[] = [];
    outbox.register('email.status', async (payload, job) => {
      seen.push({ payload, job });
    });
    await enqueue('email.status', 'zz:ok');
    // A type without a handler (every real type has one now): the job must wait for its handler.
    await prisma.outboxJob.create({ data: { type: 'zz.no_handler', dedupeKey: 'zz:no-handler', payload: {} } });

    expect(await outbox.runDue()).toBe(1);
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ key: 'zz:ok' });
    expect(seen[0].job).toMatchObject({ type: 'email.status', dedupeKey: 'zz:ok', attempts: 0 });
    expect(await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:ok' } })).toMatchObject({
      state: OutboxJobState.DONE,
      lastError: null,
    });
    const waiting = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:no-handler' } });
    expect(waiting).toMatchObject({ state: OutboxJobState.PENDING, attempts: 0, lastError: null });

    // A DONE job is never run again.
    await dueNow();
    expect(await outbox.runDue()).toBe(0);
    expect(seen).toHaveLength(1);
  });

  it('a job not yet due waits', async () => {
    let runs = 0;
    outbox.register('email.status', async () => {
      runs++;
    });
    await enqueue('email.status', 'zz:later');
    await prisma.outboxJob.update({
      where: { dedupeKey: 'zz:later' },
      data: { runAfter: new Date(Date.now() + 10 * MINUTE) },
    });
    expect(await outbox.runDue()).toBe(0);
    expect(runs).toBe(0);
  });

  it('a handler that throws retries with backoff, and after 8 attempts the job is FAILED with lastError', async () => {
    let runs = 0;
    outbox.register('email.refund', async () => {
      runs++;
      throw new Error(`provider down ${runs}`);
    });
    const order = await makeOrder('fail', OrderStatus.PAID);
    await enqueue('email.refund', 'zz:fail', order.id);

    const before = Date.now();
    await outbox.runDue();
    let row = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:fail' } });
    expect(row).toMatchObject({ state: OutboxJobState.PENDING, attempts: 1, lastError: 'provider down 1' });
    // 5 minutes after the first failure.
    expect(row.runAfter.getTime()).toBeGreaterThanOrEqual(before + 299_000);
    expect(row.runAfter.getTime()).toBeLessThan(Date.now() + 301_000);
    // Not due yet: nothing runs.
    await outbox.runDue();
    expect(runs).toBe(1);

    for (let attempt = 2; attempt <= 7; attempt++) {
      await dueNow();
      await outbox.runDue();
    }
    row = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:fail' } });
    expect(row).toMatchObject({ state: OutboxJobState.PENDING, attempts: 7 });

    await dueNow();
    await outbox.runDue();
    row = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:fail' } });
    expect(row).toMatchObject({ state: OutboxJobState.FAILED, attempts: 8, lastError: 'provider down 8' });
    expect(runs).toBe(8);

    // A FAILED job is not run again by the worker.
    await prisma.outboxJob.update({ where: { id: row.id }, data: { runAfter: new Date(Date.now() - MINUTE) } });
    await outbox.runDue();
    expect(runs).toBe(8);
  });

  it('failed jobs: listed for orders.manage, flag their order, and "retry" puts them back to PENDING (audited)', async () => {
    const order = await makeOrder('failed-list', OrderStatus.PAID);
    await enqueue('email.refund', 'zz:failed-list', order.id);
    await prisma.outboxJob.update({
      where: { dedupeKey: 'zz:failed-list' },
      data: { state: OutboxJobState.FAILED, attempts: 8, lastError: 'smtp 550' },
    });
    const job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:failed-list' } });

    await editor.get('/jobs/failed').expect(403);
    await editor.post(`/jobs/${job.id}/retry`).expect(403);

    const list = (await owner.get('/jobs/failed').expect(200)).body as AdminFailedJob[];
    expect(list).toEqual([
      {
        id: job.id,
        type: 'email.refund',
        orderNumber: order.number,
        attempts: 8,
        lastError: 'smtp 550',
        updatedAt: job.updatedAt.toISOString(),
      },
    ]);

    // The order needs attention while its job is failed.
    let detail = (await owner.get(`/orders/${order.number}`).expect(200)).body as AdminOrderDetail;
    expect(detail.needsAttention).toBe(true);
    expect(detail.attentionReasons).toContain('job_failed');
    let page = (await owner.get('/orders?attention=true').expect(200)).body as AdminOrderPage;
    expect(page.items.find((o) => o.number === order.number)?.attentionReasons).toContain('job_failed');

    await owner.post(`/jobs/${job.id}/retry`).expect(204);
    const retried = await prisma.outboxJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(retried).toMatchObject({ state: OutboxJobState.PENDING, attempts: 0, lastError: null });
    expect(retried.runAfter.getTime()).toBeLessThanOrEqual(Date.now());
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'job.retry' } });
    expect(audit).toMatchObject({ entityType: 'outbox_job', entityId: job.id });
    expect(audit.before).toMatchObject({ state: 'failed', attempts: 8, type: 'email.refund' });
    expect(audit.after).toMatchObject({ state: 'pending' });

    expect((await owner.get('/jobs/failed').expect(200)).body).toEqual([]);
    detail = (await owner.get(`/orders/${order.number}`).expect(200)).body as AdminOrderDetail;
    expect(detail.attentionReasons).not.toContain('job_failed');
    expect(detail.needsAttention).toBe(false);
    page = (await owner.get('/orders?attention=true').expect(200)).body as AdminOrderPage;
    expect(page.items.map((o) => o.number)).not.toContain(order.number);

    // Only a FAILED job can be retried; unknown or malformed ids are 404.
    expect((await owner.post(`/jobs/${job.id}/retry`).expect(409)).body.code).toBe('not_failed');
    await owner.post(`/jobs/${NO_JOB}/retry`).expect(404);
    await owner.post('/jobs/not-a-uuid/retry').expect(404);
  });

  it('two parallel runDue() never run one job twice', async () => {
    const runs = new Map<string, number>();
    outbox.register('email.status', async (_payload, job) => {
      runs.set(job.dedupeKey, (runs.get(job.dedupeKey) ?? 0) + 1);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    const count = 24;
    for (let i = 0; i < count; i++) await enqueue('email.status', `zz:parallel:${i}`);

    const claimed = await Promise.all([outbox.runDue(8), outbox.runDue(8), outbox.runDue(8), outbox.runDue(8)]);
    let total = claimed.reduce((sum, n) => sum + n, 0);
    // Whatever one round left is picked up by the next.
    while (total < count) {
      const more = await outbox.runDue(count);
      if (more === 0) break;
      total += more;
    }
    expect(total).toBe(count);
    expect(runs.size).toBe(count);
    expect([...runs.values()].every((n) => n === 1)).toBe(true);
    expect(await prisma.outboxJob.count({ where: { state: OutboxJobState.DONE } })).toBe(count);
  });

  it('a job stuck RUNNING for more than 10 minutes is reclaimed; a recent RUNNING one is left alone', async () => {
    let runs = 0;
    outbox.register('email.status', async () => {
      runs++;
    });
    await enqueue('email.status', 'zz:stuck');
    await enqueue('email.status', 'zz:busy');
    await prisma.$executeRaw`
      UPDATE outbox_jobs SET state = 'running', updated_at = (now() AT TIME ZONE 'UTC') - interval '11 minutes' WHERE dedupe_key = 'zz:stuck'`;
    await prisma.$executeRaw`
      UPDATE outbox_jobs SET state = 'running', updated_at = (now() AT TIME ZONE 'UTC') - interval '1 minute' WHERE dedupe_key = 'zz:busy'`;

    expect(await outbox.runDue()).toBe(1);
    expect(runs).toBe(1);
    // The stuck run counts as an attempt.
    expect(await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:stuck' } })).toMatchObject({
      state: OutboxJobState.DONE,
      attempts: 1,
    });
    expect((await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:busy' } })).state).toBe(
      OutboxJobState.RUNNING,
    );
  });

  it('a job that keeps getting stuck (a crashing handler) is FAILED once the stuck runs reach 8 attempts', async () => {
    let runs = 0;
    outbox.register('email.status', async () => {
      runs++;
    });
    await enqueue('email.status', 'zz:crashing');
    await prisma.$executeRaw`
      UPDATE outbox_jobs SET state = 'running', attempts = 7,
        updated_at = (now() AT TIME ZONE 'UTC') - interval '11 minutes'
      WHERE dedupe_key = 'zz:crashing'`;

    expect(await outbox.runDue()).toBe(0);
    expect(runs).toBe(0);
    expect(await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: 'zz:crashing' } })).toMatchObject({
      state: OutboxJobState.FAILED,
      attempts: 8,
      lastError: 'reclaimed after a stuck run',
    });
  });

  it('a PAID webhook enqueues the paid jobs in the webhook transaction, once', async () => {
    const order = await makeOrder('paid', OrderStatus.PENDING_PAYMENT);
    await webhook('sbx_zz_out_paid').expect(200);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(OrderStatus.PAID);
    const rows = await jobs(order.id);
    expect(rows.map((j) => [j.type, j.dedupeKey]).sort((a, b) => a[1].localeCompare(b[1]))).toEqual([
      ['email.order_paid', `email.order_paid:${order.id}`],
      ['invoice.issue', `invoice.issue:${order.id}`],
    ]);
    expect(rows.every((j) => j.state === OutboxJobState.PENDING)).toBe(true);
    expect(rows[0].payload).toEqual({ orderId: order.id });

    // A repeated webhook adds nothing.
    await webhook('sbx_zz_out_paid').expect(200);
    expect(await jobs(order.id)).toHaveLength(2);
  });

  it('paid jobs: none for paid_twice; a superseded_paid order is a real paid order and gets both', async () => {
    const twice = await makeOrder('twice', OrderStatus.PAID);
    await prisma.payment.create({
      data: { orderId: twice.id, provider: 'sandbox', transactionId: 'sbx_zz_out_twice-2', amount: TOTAL },
    });
    await webhook('sbx_zz_out_twice-2').expect(200);
    expect((await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_out_twice-2' } })).rawStatus).toBe(
      'paid_twice',
    );
    expect(await jobs(twice.id)).toHaveLength(0);

    const cart = await prisma.cart.create({ data: { tokenHash: 'zz-out-superseded' } });
    try {
      const older = await makeOrder('superseded-old', OrderStatus.PENDING_PAYMENT);
      const newer = await makeOrder('superseded-new', OrderStatus.PAID);
      await prisma.order.updateMany({ where: { id: { in: [older.id, newer.id] } }, data: { cartId: cart.id } });
      await webhook('sbx_zz_out_superseded-old').expect(200);
      expect(
        (await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_out_superseded-old' } })).rawStatus,
      ).toBe('superseded_paid');
      expect(await keys(older.id)).toEqual([`email.order_paid:${older.id}`, `invoice.issue:${older.id}`]);
    } finally {
      await prisma.cart.delete({ where: { id: cart.id } });
    }
  });

  it('a webhook whose transaction fails after the first job leaves no job and the order unpaid', async () => {
    const order = await makeOrder('paid-rollback', OrderStatus.PENDING_PAYMENT);
    const original = outbox.enqueue.bind(outbox);
    let calls = 0;
    const spy = vi.spyOn(outbox, 'enqueue').mockImplementation(async (tx, job) => {
      calls++;
      if (calls === 2) throw new Error('crash between the two jobs');
      return original(tx, job);
    });
    try {
      await webhook('sbx_zz_out_paid-rollback').expect(500);
    } finally {
      spy.mockRestore();
    }
    expect(calls).toBe(2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe(
      OrderStatus.PENDING_PAYMENT,
    );
    expect(await jobs(order.id)).toHaveLength(0);

    // The provider repeats the webhook: now it goes through, with both jobs.
    await webhook('sbx_zz_out_paid-rollback').expect(200);
    expect(await keys(order.id)).toEqual([`email.order_paid:${order.id}`, `invoice.issue:${order.id}`]);
  });

  it('status moves enqueue their jobs: slot SMS (also on a slot change), shipped / delivered e-mails', async () => {
    const order = await makeOrder('flow', OrderStatus.PAID);
    const n = order.number;
    await owner.post(`/orders/${n}/status`, { to: 'processing' }).expect(201);
    expect(await jobs(order.id)).toHaveLength(0);

    await owner
      .post(`/orders/${n}/status`, {
        to: 'delivery_scheduled',
        slot: { date: israelDate(3), windowFrom: '09:00', windowTo: '13:00' },
      })
      .expect(201);
    const first = await prisma.deliverySlot.findFirstOrThrow({ where: { orderId: order.id } });
    expect(await keys(order.id)).toEqual([`sms.delivery_slot:${first.id}`]);
    expect(
      (await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `sms.delivery_slot:${first.id}` } })).payload,
    ).toEqual({
      orderId: order.id,
      slotId: first.id,
    });

    // A new slot for the same status: an SMS for the new slot, no status e-mail.
    await owner
      .post(`/orders/${n}/status`, {
        to: 'delivery_scheduled',
        slot: { date: israelDate(4), windowFrom: '14:00', windowTo: '18:00' },
      })
      .expect(201);
    const second = await prisma.deliverySlot.findFirstOrThrow({
      where: { orderId: order.id, state: { not: 'SUPERSEDED' } },
    });
    expect(second.id).not.toBe(first.id);
    expect(await keys(order.id)).toEqual([`sms.delivery_slot:${first.id}`, `sms.delivery_slot:${second.id}`].sort());

    await owner.post(`/orders/${n}/status`, { to: 'shipped' }).expect(201);
    await owner.post(`/orders/${n}/status`, { to: 'delivered' }).expect(201);
    expect(await keys(order.id)).toEqual(
      [
        `sms.delivery_slot:${first.id}`,
        `sms.delivery_slot:${second.id}`,
        `email.status:${order.id}:shipped`,
        `email.status:${order.id}:delivered`,
      ].sort(),
    );
    const shipped = await prisma.outboxJob.findUniqueOrThrow({
      where: { dedupeKey: `email.status:${order.id}:shipped` },
    });
    expect(shipped).toMatchObject({
      type: 'email.status',
      orderId: order.id,
      payload: { orderId: order.id, status: 'shipped' },
    });
  });

  it('cancels enqueue the cancel e-mail; a succeeded refund enqueues its e-mail and credit note', async () => {
    const byCustomer = await makeOrder('cancel-customer', OrderStatus.PENDING_PAYMENT);
    await http()
      .post(`/api/orders/${byCustomer.number}/cancel?t=${byCustomer.publicToken}`)
      .set('Origin', ORIGIN)
      .expect(201);
    expect(await keys(byCustomer.id)).toEqual([`email.cancelled:${byCustomer.id}`]);

    const byStaff = await makeOrder('cancel-staff', OrderStatus.PAID);
    await owner
      .post(`/orders/${byStaff.number}/cancel`, { refund: 'full', reason: 'הלקוח ביקש', restock: false })
      .expect(200);
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: byStaff.id } });
    expect(refund.status).toBe(RefundStatus.SUCCEEDED);
    expect(await keys(byStaff.id)).toEqual(
      [`email.cancelled:${byStaff.id}`, `email.refund:${refund.id}`, `invoice.credit_note:${refund.id}`].sort(),
    );
    const credit = await prisma.outboxJob.findUniqueOrThrow({
      where: { dedupeKey: `invoice.credit_note:${refund.id}` },
    });
    expect(credit).toMatchObject({ orderId: byStaff.id, payload: { orderId: byStaff.id, refundId: refund.id } });

    // A failed refund enqueues nothing.
    const failing = await makeOrder('refund-fail', OrderStatus.PAID);
    process.env.PAYMENT_SANDBOX_FAIL_REFUNDS = 'true';
    try {
      await owner.post(`/orders/${failing.number}/refunds`, { amount: 10_000, reason: 'בדיקה' }).expect(200);
    } finally {
      delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    }
    expect(await jobs(failing.id)).toHaveLength(0);
  });

  it('a late payment enqueues its refund job (one per payment), and the job refunds it', async () => {
    const order = await makeOrder('late', OrderStatus.PENDING_PAYMENT);
    await http().post(`/api/orders/${order.number}/cancel?t=${order.publicToken}`).set('Origin', ORIGIN).expect(201);
    await webhook('sbx_zz_out_late').expect(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_out_late' } });
    const key = `refund.late_payment:${payment.id}`;
    const job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(job).toMatchObject({
      type: 'refund.late_payment',
      orderId: order.id,
      state: OutboxJobState.PENDING,
      payload: { orderId: order.id, paymentId: payment.id, amount: TOTAL },
    });
    // Nothing is refunded inside the webhook any more.
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(0);
    await webhook('sbx_zz_out_late').expect(200);
    expect(await prisma.outboxJob.count({ where: { type: 'refund.late_payment', orderId: order.id } })).toBe(1);

    expect(await outbox.runDue()).toBeGreaterThanOrEqual(1);
    expect((await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } })).state).toBe(OutboxJobState.DONE);
    const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id }, include: { refunds: true } });
    expect(row.refunds).toHaveLength(1);
    expect(row.refunds[0]).toMatchObject({ status: RefundStatus.SUCCEEDED, amount: TOTAL, reason: 'late_payment' });
    expect(row.refundedTotal).toBe(TOTAL);
    expect(row.attentionNote).toBe('תשלום התקבל אחרי ביטול — הוחזר');
    // The order was never invoiced: the late-payment refund gets its e-mail but no credit note.
    const refundId = row.refunds[0].id;
    expect(await keys(order.id)).toEqual(
      [`email.cancelled:${order.id}`, `email.refund:${refundId}`, `refund.late_payment:${payment.id}`].sort(),
    );
    expect(await prisma.outboxJob.count({ where: { dedupeKey: { endsWith: refundId } } })).toBe(1);

    // Running the same job again (a crash before DONE) never refunds twice.
    await prisma.outboxJob.update({ where: { dedupeKey: key }, data: { state: OutboxJobState.PENDING } });
    await dueNow();
    await outbox.runDue();
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedTotal).toBe(TOTAL);
  });

  it('the late-payment job retries while its refund is still in flight, and finishes it once it is stale', async () => {
    const order = await makeOrder('late-inflight', OrderStatus.PENDING_PAYMENT);
    await http().post(`/api/orders/${order.number}/cancel?t=${order.publicToken}`).set('Origin', ORIGIN).expect(201);
    await webhook('sbx_zz_out_late-inflight').expect(200);
    const payment = await prisma.payment.findUniqueOrThrow({ where: { transactionId: 'sbx_zz_out_late-inflight' } });
    const key = `refund.late_payment:${payment.id}`;
    // An earlier run reserved the refund and is still calling the provider (or crashed a moment ago).
    const inflight = await prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        amount: TOTAL,
        reason: 'late_payment',
        provider: 'sandbox',
        status: RefundStatus.PENDING,
        idempotencyKey: 'refund:zz-out-inflight',
      },
    });

    await outbox.runDue();
    let job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(job).toMatchObject({ state: OutboxJobState.PENDING, attempts: 1 });
    expect(job.lastError).toBeTruthy();
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: inflight.id } })).toMatchObject({ status: 'PENDING' });

    // Later the refund has lost its result: the job executes it with its own key and finishes.
    await prisma.$executeRaw`
      UPDATE refunds SET updated_at = (now() AT TIME ZONE 'UTC') - interval '3 minutes' WHERE id = ${inflight.id}::uuid`;
    await dueNow();
    await outbox.runDue();
    job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: key } });
    expect(job.state).toBe(OutboxJobState.DONE);
    expect(await prisma.refund.findUniqueOrThrow({ where: { id: inflight.id } })).toMatchObject({
      status: 'SUCCEEDED',
      providerRefundId: 'sbx_rf_refund:zz-out-inflight',
    });
    expect(await prisma.refund.count({ where: { orderId: order.id } })).toBe(1);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).refundedTotal).toBe(TOTAL);
  });

  it('a cancel from delivery_scheduled or shipped enqueues the cancel e-mail', async () => {
    for (const status of [OrderStatus.DELIVERY_SCHEDULED, OrderStatus.SHIPPED]) {
      const order = await makeOrder(`cancel-from-${status}`, status);
      await owner
        .post(`/orders/${order.number}/cancel`, { refund: 'none', reason: 'בוטל על ידי הצוות', restock: false })
        .expect(200);
      expect(await keys(order.id)).toEqual([`email.cancelled:${order.id}`]);
    }
  });
});
