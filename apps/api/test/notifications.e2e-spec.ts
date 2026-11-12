import { vi } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { AdminSentMessage } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { OrderShippingMethod, OrderStatus, OutboxJobState, PaymentStatus } from './../src/generated/prisma/client.js';
import { EMAIL_PROVIDER, type EmailProvider } from './../src/notifications/notification-provider.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { sign } from './../src/payments/webhook-signature.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { deleteOrders, TEST_ORDERS } from './test-orders.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const SECRET = process.env.PAYMENT_SANDBOX_SECRET ?? '';
const MINUTE = 60_000;
const TOTAL = 100_000;
const SITE = 'http://localhost:4200';

// Order e-mails through the NotificationProvider (spec §5.2, §5.3, CHK-07): the outbox handlers render a Hebrew
// template, send through the mock and log the message. The worker is off in e2e; the tests call runDue().
describe('Notifications (e2e, CHK-07)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let email: EmailProvider;

  const http = () => request(app.getHttpServer() as App);
  const cleanup = async () => {
    await deleteOrders(prisma, TEST_ORDERS);
    await prisma.outboxJob.deleteMany({});
    await prisma.notificationLog.deleteMany({});
  };
  const runJobs = () => outbox.runDue(100);
  const dueNow = () =>
    prisma.$executeRaw`UPDATE outbox_jobs SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE state = 'pending'`;
  const logs = (orderId: string) =>
    prisma.notificationLog.findMany({ where: { orderId }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });

  const makeOrder = (key: string, status: OrderStatus) =>
    prisma.order.create({
      data: {
        publicToken: `zz-token-ntf-${key}`,
        status,
        contact: { fullName: `ZZ ntf ${key}`, phone: '0501234567', email: 'zz@example.test' },
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
              sku: `ZZ-NTF-${key}`,
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
              transactionId: `sbx_zz_ntf_${key}`,
              status: status === OrderStatus.PENDING_PAYMENT ? PaymentStatus.PENDING : PaymentStatus.SUCCEEDED,
              amount: TOTAL,
            },
          ],
        },
      },
    });
  const webhook = (transactionId: string) => {
    const body = JSON.stringify({ transactionId, status: 'succeeded', amount: TOTAL, installments: 1 });
    return http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', sign(body, SECRET))
      .send(body);
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.init();
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    email = app.get<EmailProvider>(EMAIL_PROVIDER);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    await owner.put('/users/me/opt-in', { permissions: ['orders.cancel'] }).expect(200);
  });

  beforeEach(async () => {
    await prisma.outboxJob.deleteMany({});
  });

  afterAll(async () => {
    vi.restoreAllMocks();
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('a paid order sends one order_paid e-mail (also when the webhook repeats) with the order link', async () => {
    const order = await makeOrder('paid', OrderStatus.PENDING_PAYMENT);
    await webhook('sbx_zz_ntf_paid').expect(200);
    await webhook('sbx_zz_ntf_paid').expect(200);
    await runJobs();
    await dueNow();
    await runJobs();

    const rows = await logs(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      channel: 'EMAIL',
      template: 'order_paid',
      provider: 'mock',
      status: 'SENT',
      recipientMasked: 'z***@example.test',
    });
    expect(rows[0].providerMessageId).toMatch(/^mock_/);
    expect(rows[0].subject).toBe(`ההזמנה ${order.number} התקבלה`);
    expect(rows[0].body).toContain('dir="rtl"');
    expect(rows[0].body).toContain(`${SITE}/order/${order.number}?t=${order.publicToken}`);
    expect(rows[0].body).toContain('ZZ ALBA');
    expect(rows[0].body).toContain('החשבונית זמינה בעמוד ההזמנה.');
    // The full address is never stored outside the mock body.
    expect(rows[0].recipientMasked).not.toContain('zz@example.test');
    const job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `email.order_paid:${order.id}` } });
    expect(job.state).toBe(OutboxJobState.DONE);
  });

  it('shipped and delivered send status e-mails', async () => {
    const order = await makeOrder('status', OrderStatus.PAID);
    const move = (body: object) => owner.post(`/orders/${order.number}/status`, body).expect(201);
    await move({ to: 'processing' });
    await move({
      to: 'delivery_scheduled',
      slot: {
        date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(Date.now() + 3 * 86_400_000),
        windowFrom: '09:00',
        windowTo: '13:00',
      },
    });
    await move({ to: 'shipped' });
    await move({ to: 'delivered' });
    await runJobs();
    const rows = await logs(order.id);
    expect(rows.map((r) => r.template).sort()).toEqual(['delivery_slot', 'status_delivered', 'status_shipped']);
    const shipped = rows.find((r) => r.template === 'status_shipped');
    expect(shipped?.subject).toBe(`ההזמנה ${order.number} בדרך אליך`);
    expect(rows.find((r) => r.template === 'status_delivered')?.subject).toBe(`ההזמנה ${order.number} סופקה`);
    // The delivery SMS has its own handler (Task 8): the job ran.
    expect(
      await prisma.outboxJob.count({ where: { orderId: order.id, type: 'sms.delivery_slot', state: 'DONE' } }),
    ).toBe(1);
  });

  it('a cancel with a full refund sends the cancelled and the refund e-mails', async () => {
    const order = await makeOrder('cancel', OrderStatus.PAID);
    await owner
      .post(`/orders/${order.number}/cancel`, { refund: 'full', reason: 'הלקוח ביקש', restock: false })
      .expect(200);
    await runJobs();
    const rows = await logs(order.id);
    expect(rows.map((r) => r.template).sort()).toEqual(['order_cancelled', 'refund']);
    expect(rows.find((r) => r.template === 'order_cancelled')?.subject).toBe(`ההזמנה ${order.number} בוטלה`);
    const refund = rows.find((r) => r.template === 'refund');
    expect(refund?.subject).toBe('בוצע החזר של 1,000 ₪');
    expect(refund?.body).toContain('1,000 ₪');
    expect(refund?.body).toContain('חשבונית הזיכוי זמינה בעמוד ההזמנה.');
  });

  it('a late-payment refund e-mail does not promise a credit note', async () => {
    const order = await makeOrder('late', OrderStatus.CANCELLED);
    const payment = await prisma.payment.findFirstOrThrow({ where: { orderId: order.id } });
    const refund = await prisma.refund.create({
      data: {
        orderId: order.id,
        paymentId: payment.id,
        amount: TOTAL,
        reason: 'late_payment',
        provider: 'sandbox',
        status: 'SUCCEEDED',
        idempotencyKey: `zz-ntf-late-${order.id}`,
      },
    });
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        type: 'email.refund',
        dedupeKey: `email.refund:${refund.id}`,
        payload: { orderId: order.id, refundId: refund.id },
        orderId: order.id,
      }),
    );
    await runJobs();
    const rows = await logs(order.id);
    expect(rows.map((r) => r.template)).toEqual(['refund']);
    expect(rows[0].body).not.toContain('חשבונית הזיכוי');
  });

  describe('a cancel before the jobs run', () => {
    const slot = {
      date: new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(Date.now() + 3 * 86_400_000),
      windowFrom: '09:00',
      windowTo: '13:00',
    };
    const move = (number: number, body: object) => owner.post(`/orders/${number}/status`, body).expect(201);
    const cancelOrder = (number: number) =>
      owner.post(`/orders/${number}/cancel`, { refund: 'none', reason: 'הלקוח ביקש', restock: false }).expect(200);

    it('schedule then cancel: the slot is superseded, no delivery SMS, only the cancelled e-mail', async () => {
      const order = await makeOrder('cancel-slot', OrderStatus.PROCESSING);
      await move(order.number, { to: 'delivery_scheduled', slot });
      await cancelOrder(order.number);
      expect((await prisma.deliverySlot.findFirstOrThrow({ where: { orderId: order.id } })).state).toBe('SUPERSEDED');
      await runJobs();
      expect((await logs(order.id)).map((r) => r.template)).toEqual(['order_cancelled']);
      expect(
        await prisma.outboxJob.count({ where: { orderId: order.id, type: 'sms.delivery_slot', state: 'DONE' } }),
      ).toBe(1);
    });

    it('shipped then cancel: no status e-mail, and the delivery link sent earlier answers 404', async () => {
      const order = await makeOrder('cancel-shipped', OrderStatus.PROCESSING);
      await move(order.number, { to: 'delivery_scheduled', slot });
      await runJobs();
      const sms = (await logs(order.id)).find((r) => r.template === 'delivery_slot');
      const token = /\/delivery\/([\w-]+)/.exec(sms?.body ?? '')![1];
      await http().get(`/api/delivery/${token}`).expect(200);
      await move(order.number, { to: 'shipped' });
      await cancelOrder(order.number);
      await runJobs();
      expect((await logs(order.id)).map((r) => r.template)).toEqual(['delivery_slot', 'order_cancelled']);
      expect(await prisma.outboxJob.count({ where: { orderId: order.id, type: 'email.status', state: 'DONE' } })).toBe(
        1,
      );
      await http().get(`/api/delivery/${token}`).expect(404);
      await http().post(`/api/delivery/${token}`).set('Origin', SITE).send({ answer: 'confirm' }).expect(404);
    });

    it('the delivery SMS job sends nothing for a cancelled order, even with a live slot', async () => {
      const order = await makeOrder('cancel-live', OrderStatus.PROCESSING);
      await move(order.number, { to: 'delivery_scheduled', slot });
      // An order cancelled without superseding its slot (data from before the cancel did it).
      await prisma.order.update({ where: { id: order.id }, data: { status: OrderStatus.CANCELLED } });
      await runJobs();
      expect(await logs(order.id)).toEqual([]);
      expect((await prisma.deliverySlot.findFirstOrThrow({ where: { orderId: order.id } })).tokenHash).toBeNull();
    });
  });

  it('a provider error fails the job, logs a failed row, and the retry sends it', async () => {
    const order = await makeOrder('retry', OrderStatus.PENDING_PAYMENT);
    const spy = vi.spyOn(email, 'sendEmail').mockRejectedValueOnce(new Error('smtp down'));
    await webhook('sbx_zz_ntf_retry').expect(200);
    await runJobs();

    let job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `email.order_paid:${order.id}` } });
    expect(job).toMatchObject({ state: OutboxJobState.PENDING, attempts: 1, lastError: 'smtp down' });
    expect((await logs(order.id)).map((r) => r.status)).toEqual(['FAILED']);

    await dueNow();
    await runJobs();
    job = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `email.order_paid:${order.id}` } });
    expect(job.state).toBe(OutboxJobState.DONE);
    expect((await logs(order.id)).map((r) => r.status)).toEqual(['FAILED', 'SENT']);
    spy.mockRestore();
  });

  it('dev viewer: orders.manage only, newest first, with the body', async () => {
    await editor.get('/dev/messages').expect(403);
    const list = (await owner.get('/dev/messages').expect(200)).body as AdminSentMessage[];
    expect(list.length).toBeGreaterThan(0);
    expect(list.length).toBeLessThanOrEqual(100);
    const times = list.map((m) => Date.parse(m.createdAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    const paid = list.find((m) => m.template === 'order_paid' && m.status === 'sent');
    expect(paid).toMatchObject({ channel: 'email', provider: 'mock', recipientMasked: 'z***@example.test' });
    expect(paid?.body).toContain('dir="rtl"');
    expect(paid?.orderNumber).toBeGreaterThan(0);
  });

  it('dev viewer: 404 unless both providers are mock', async () => {
    const real = Object.getOwnPropertyDescriptor(email, 'code');
    Object.defineProperty(email, 'code', { value: 'ses', configurable: true });
    try {
      await owner.get('/dev/messages').expect(404);
    } finally {
      if (real) Object.defineProperty(email, 'code', real);
    }
    await owner.get('/dev/messages').expect(200);
  });
});
