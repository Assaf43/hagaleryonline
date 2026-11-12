import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { AdminOrderDetail, OrderView } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import {
  InvoiceType,
  OrderShippingMethod,
  OrderStatus,
  OutboxJobState,
  PaymentStatus,
} from './../src/generated/prisma/client.js';
import { InvoicingService } from './../src/invoicing/invoicing.service.js';
import { israelDate } from './../src/invoicing/vat.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { sign } from './../src/payments/webhook-signature.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteOrders, TEST_ORDERS } from './test-orders.js';

const SECRET = process.env.PAYMENT_SANDBOX_SECRET ?? '';
const MINUTE = 60_000;
// 2 × 500 ₪ − 100 ₪ discount + 150 ₪ shipping (100 delivery + 50 carry-up) = 1,050 ₪.
const SUBTOTAL = 100_000;
const DISCOUNT = 10_000;
const SHIPPING = 15_000;
const TOTAL = SUBTOTAL - DISCOUNT + SHIPPING;
const MEDIA_DIR = process.env.MEDIA_DIR ?? '';
const NO_ID = '00000000-0000-4000-8000-000000000000';

/** VAT inside a gross amount at 18% (the migration's rate), whole agorot. */
const vat18 = (gross: number) => Math.round(gross - gross / 1.18);

// Invoices and credit notes through the InvoiceProvider (spec §5.4, CHK-08, decision 81): issued exactly once by
// outbox jobs, stored privately, reachable by the customer with the order token and by staff with invoices.export.
describe('Invoices (e2e, CHK-08)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let invoicing: InvoicingService;
  let owner: AdminBrowser;
  /** customer_service: orders.view, no invoices.export. */
  let service: AdminBrowser;

  const http = () => request(app.getHttpServer() as App);
  const cleanup = async () => {
    // Invoices restrict deleting their order and refund (tax documents): the helper removes them first.
    await deleteOrders(prisma, TEST_ORDERS);
    await prisma.outboxJob.deleteMany({});
    await prisma.notificationLog.deleteMany({});
  };
  const runJobs = () => outbox.runDue(100);
  const dueNow = () =>
    prisma.$executeRaw`UPDATE outbox_jobs SET run_after = (now() AT TIME ZONE 'UTC') - interval '1 second' WHERE state = 'pending'`;
  /** What the outbox hands a handler: the job's dedupe key and its creation time (the event's moment). */
  const job = (dedupeKey: string, createdAt = new Date()) => ({ dedupeKey, createdAt });
  /** "13.11.2026": how the mock document writes the Israel date. */
  const docDate = (at: Date) => {
    const [y, m, d] = israelDate(at).split('-');
    return `${Number(d)}.${Number(m)}.${y}`;
  };
  const invoices = (orderId: string) =>
    prisma.invoice.findMany({ where: { orderId }, orderBy: [{ issuedAt: 'asc' }, { id: 'asc' }] });

  const makeOrder = (key: string, status: OrderStatus, total = TOTAL) =>
    prisma.order.create({
      data: {
        publicToken: `zz-token-inv-${key}`,
        status,
        contact: { fullName: `ZZ inv ${key} <b>`, phone: '0501234567', email: 'zz@example.test' },
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
        method: OrderShippingMethod.FULL_SERVICE,
        shippingTotal: SHIPPING,
        shippingLines: [
          { labelHe: 'הובלה', amount: 10_000 },
          { labelHe: 'הכנסה לבית', amount: 5_000 },
        ],
        subtotal: SUBTOTAL,
        discount: DISCOUNT,
        discountInfo: { name: 'חורף', kind: 'coupon', code: 'WINTER', labelHe: 'קופון WINTER', source: 'coupon' },
        total,
        deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 3 },
        paymentProvider: 'sandbox',
        shippingProvider: 'manual',
        reservedUntil: new Date(Date.now() + 20 * MINUTE),
        items: {
          create: [
            {
              variantId: null,
              sku: `ZZ-INV-${key}`,
              modelName: 'ZZ ALBA',
              nameHe: 'ספה תלת־מושבית',
              optionLabels: ['בז׳', 'פינה ימנית'],
              unitPrice: 50_000,
              quantity: 2,
              lineTotal: SUBTOTAL,
            },
          ],
        },
        payments: {
          create: [
            {
              provider: 'sandbox',
              transactionId: `sbx_zz_inv_${key}`,
              status: status === OrderStatus.PENDING_PAYMENT ? PaymentStatus.PENDING : PaymentStatus.SUCCEEDED,
              amount: total,
            },
          ],
        },
      },
    });
  const webhook = (transactionId: string, amount = TOTAL) => {
    const body = JSON.stringify({ transactionId, status: 'succeeded', amount, installments: 1 });
    return http()
      .post('/api/payments/webhook')
      .set('Content-Type', 'application/json')
      .set('x-sandbox-signature', sign(body, SECRET))
      .send(body);
  };
  /** A pending order paid by webhook, with its jobs run: it has its tax invoice. */
  const paidOrder = async (key: string) => {
    const order = await makeOrder(key, OrderStatus.PENDING_PAYMENT);
    await webhook(`sbx_zz_inv_${key}`).expect(200);
    await runJobs();
    return order;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.init();
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    invoicing = app.get(InvoicingService);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: service } = await signInOwnerAnd(app, 'customer_service'));
    await owner.put('/users/me/opt-in', { permissions: ['orders.cancel'] }).expect(200);
  });

  beforeEach(async () => {
    await prisma.outboxJob.deleteMany({});
  });

  afterAll(async () => {
    delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('the VAT table holds 18% from 1.1.2025 (migration invoices)', async () => {
    const rates = await prisma.vatRate.findMany();
    expect(rates.map((r) => [Number(r.rate), r.effectiveFrom.toISOString().slice(0, 10)])).toContainEqual([
      0.18,
      '2025-01-01',
    ]);
  });

  it('a paid webhook (twice) issues one tax invoice and one order_paid e-mail; the job run again changes nothing', async () => {
    const order = await makeOrder('paid', OrderStatus.PENDING_PAYMENT);
    await webhook('sbx_zz_inv_paid').expect(200);
    await webhook('sbx_zz_inv_paid').expect(200);
    await runJobs();
    await dueNow();
    await runJobs();

    const rows = await invoices(order.id);
    expect(rows).toHaveLength(1);
    const [invoice] = rows;
    expect(invoice).toMatchObject({
      type: InvoiceType.TAX_INVOICE_RECEIPT,
      provider: 'mock',
      amount: TOTAL,
      vatAmount: vat18(TOTAL),
      refundId: null,
      idempotencyKey: `invoice.issue:${order.id}`,
    });
    expect(Number(invoice.vatRate)).toBe(0.18);
    expect(invoice.number).toMatch(/^MOCK-INV-\d{6}$/);
    expect(invoice.fileKey).toBe(`invoices/${invoice.number}.html`);
    expect(
      await prisma.notificationLog.count({ where: { orderId: order.id, template: 'order_paid', status: 'SENT' } }),
    ).toBe(1);
    const issueJob = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `invoice.issue:${order.id}` } });
    expect(issueJob.state).toBe(OutboxJobState.DONE);
    // The issue date is the event's moment (the job's creation), not the run's.
    expect(invoice.issuedAt.toISOString()).toBe(issueJob.createdAt.toISOString());

    // The private file: Hebrew RTL, seller, escaped buyer, lines, VAT and total; never under the public folder.
    const path = join(MEDIA_DIR, 'private', 'invoices', `${invoice.number}.html`);
    expect(existsSync(path)).toBe(true);
    expect(existsSync(join(MEDIA_DIR, 'public', 'invoices', `${invoice.number}.html`))).toBe(false);
    const html = readFileSync(path, 'utf8');
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('NESTO');
    expect(html).toContain('חשבונית מס/קבלה');
    expect(html).toContain(invoice.number);
    expect(html).toContain(String(order.number));
    expect(html).toContain('ZZ inv paid &lt;b&gt;');
    expect(html).not.toContain('ZZ inv paid <b>');
    expect(html).toContain('ZZ ALBA ספה תלת־מושבית בז׳, פינה ימנית');
    expect(html).toContain('הובלה');
    expect(html).toContain('קופון WINTER');
    expect(html).toContain('18%');
    expect(html).toContain(docDate(invoice.issuedAt));

    // Running the job again (as after a crash before DONE) finds the invoice and issues nothing new.
    await prisma.outboxJob.update({
      where: { id: issueJob.id },
      data: { state: OutboxJobState.PENDING, runAfter: new Date(Date.now() - 1000) },
    });
    await runJobs();
    expect(await invoices(order.id)).toHaveLength(1);
  });

  it('two parallel runs of the same job leave one invoice and both succeed', async () => {
    const order = await makeOrder('parallel', OrderStatus.PAID);
    const key = `invoice.issue:${order.id}`;
    const paidAt = new Date(Date.now() - 60_000);
    await Promise.all([
      invoicing.issueInvoice({ orderId: order.id }, job(key, paidAt)),
      invoicing.issueInvoice({ orderId: order.id }, job(key, paidAt)),
      invoicing.issueInvoice({ orderId: order.id }, job(key, paidAt)),
    ]);
    const rows = await invoices(order.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].amount).toBe(TOTAL);
  });

  it('after a crash between the provider and the row, the re-run gets the same number, date and VAT', async () => {
    const order = await paidOrder('crash');
    const [first] = await invoices(order.id);
    const html = readFileSync(join(MEDIA_DIR, 'private', 'invoices', `${first.number}.html`), 'utf8');
    // The provider issued the document, but the row was never written.
    await prisma.invoice.delete({ where: { id: first.id } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await prisma.outboxJob.updateMany({
      where: { dedupeKey: `invoice.issue:${order.id}` },
      data: { state: OutboxJobState.PENDING, runAfter: new Date(Date.now() - 1000) },
    });
    await runJobs();

    const [again] = await invoices(order.id);
    expect(again).toMatchObject({
      number: first.number,
      issuedAt: first.issuedAt,
      vatAmount: first.vatAmount,
      amount: first.amount,
    });
    expect(Number(again.vatRate)).toBe(Number(first.vatRate));
    expect(readFileSync(join(MEDIA_DIR, 'private', 'invoices', `${again.number}.html`), 'utf8')).toBe(html);
  });

  it('a ₪0 order gets no tax document: the job ends DONE without issuing', async () => {
    const order = await makeOrder('zero', OrderStatus.PAID, 0);
    await prisma.$transaction((tx) =>
      outbox.enqueue(tx, {
        type: 'invoice.issue',
        dedupeKey: `invoice.issue:${order.id}`,
        payload: { orderId: order.id },
        orderId: order.id,
      }),
    );
    await runJobs();
    const done = await prisma.outboxJob.findUniqueOrThrow({ where: { dedupeKey: `invoice.issue:${order.id}` } });
    expect(done.state).toBe(OutboxJobState.DONE);
    expect(await invoices(order.id)).toHaveLength(0);
  });

  it('never issues a tax document whose lines do not add up to the order total', async () => {
    const order = await makeOrder('mismatch', OrderStatus.PAID, TOTAL + 100);
    await expect(invoicing.issueInvoice({ orderId: order.id }, job(`invoice.issue:${order.id}`))).rejects.toThrow(
      /do not add up/,
    );
    expect(await invoices(order.id)).toHaveLength(0);
  });

  it('the database refuses to delete an order or a refund that has a tax document', async () => {
    const order = await paidOrder('restrict');
    await owner.post(`/orders/${order.number}/refunds`, { amount: 10_000, reason: 'בדיקה' }).expect(200);
    await runJobs();
    expect(await invoices(order.id)).toHaveLength(2);
    await expect(prisma.order.delete({ where: { id: order.id } })).rejects.toThrow();
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    await expect(prisma.refund.delete({ where: { id: refund.id } })).rejects.toThrow();
    expect(await prisma.order.count({ where: { id: order.id } })).toBe(1);
    expect(await invoices(order.id)).toHaveLength(2);
  });

  it('a credit note keeps the VAT rate of the order tax invoice, even after the rate changed', async () => {
    const order = await paidOrder('rate');
    const [invoice] = await invoices(order.id);
    expect(Number(invoice.vatRate)).toBe(0.18);
    // A new rate in force from today, so after the invoice's own rate.
    const today = new Date(`${israelDate(new Date())}T00:00:00.000Z`);
    const added = await prisma.vatRate.create({ data: { rate: 0.2, effectiveFrom: today } });
    try {
      await owner.post(`/orders/${order.number}/refunds`, { amount: 11_800, reason: 'בדיקה' }).expect(200);
      await runJobs();
    } finally {
      await prisma.vatRate.delete({ where: { id: added.id } });
    }
    const note = (await invoices(order.id)).find((i) => i.type === InvoiceType.CREDIT_NOTE);
    expect(note).toMatchObject({ amount: 11_800, vatAmount: 1_800 });
    expect(Number(note?.vatRate)).toBe(0.18);
  });

  it('every succeeded refund issues a credit note for its amount; a failed refund issues none', async () => {
    const order = await paidOrder('refund');
    const invoice = (await invoices(order.id))[0];
    expect(invoice.type).toBe(InvoiceType.TAX_INVOICE_RECEIPT);

    await owner.post(`/orders/${order.number}/refunds`, { amount: 20_000, reason: 'שריטה בדופן' }).expect(200);
    await owner.post(`/orders/${order.number}/refunds`, { amount: 5_000, reason: 'פיצוי על איחור' }).expect(200);
    process.env.PAYMENT_SANDBOX_FAIL_REFUNDS = 'true';
    try {
      await owner.post(`/orders/${order.number}/refunds`, { amount: 7_000, reason: 'נכשל' }).expect(200);
    } finally {
      delete process.env.PAYMENT_SANDBOX_FAIL_REFUNDS;
    }
    await runJobs();

    const refunds = await prisma.refund.findMany({ where: { orderId: order.id }, orderBy: { createdAt: 'asc' } });
    expect(refunds.map((r) => r.status)).toEqual(['SUCCEEDED', 'SUCCEEDED', 'FAILED']);
    const notes = (await invoices(order.id)).filter((i) => i.type === InvoiceType.CREDIT_NOTE);
    expect(notes).toHaveLength(2);
    for (const [i, amount] of [20_000, 5_000].entries()) {
      const note = notes.find((n) => n.refundId === refunds[i].id);
      expect(note).toMatchObject({
        amount,
        vatAmount: vat18(amount),
        provider: 'mock',
        idempotencyKey: `invoice.credit_note:${refunds[i].id}`,
      });
      expect(note?.number).toMatch(/^MOCK-CN-\d{6}$/);
      const html = readFileSync(join(MEDIA_DIR, 'private', 'invoices', `${note?.number}.html`), 'utf8');
      expect(html).toContain('חשבונית זיכוי');
      expect(html).toContain(`זיכוי להזמנה ${order.number}`);
    }
    expect(notes.some((n) => n.refundId === refunds[2].id)).toBe(false);
  });

  it('a credit note waits (retries) until the order has its tax invoice', async () => {
    // Paid without a webhook: no invoice job, so no tax invoice yet.
    const order = await makeOrder('no-invoice', OrderStatus.PAID);
    await owner.post(`/orders/${order.number}/refunds`, { amount: 10_000, reason: 'בדיקה' }).expect(200);
    await runJobs();
    const refund = await prisma.refund.findFirstOrThrow({ where: { orderId: order.id } });
    const noteJob = await prisma.outboxJob.findUniqueOrThrow({
      where: { dedupeKey: `invoice.credit_note:${refund.id}` },
    });
    expect(noteJob).toMatchObject({ state: OutboxJobState.PENDING, attempts: 1 });
    expect(noteJob.lastError).toMatch(/tax invoice/);
    expect(await invoices(order.id)).toHaveLength(0);

    // Paid before the refund: the invoice's event time is earlier than the credit note's.
    await invoicing.issueInvoice(
      { orderId: order.id },
      job(`invoice.issue:${order.id}`, new Date(Date.now() - 60_000)),
    );
    await dueNow();
    await runJobs();
    expect((await invoices(order.id)).map((i) => i.type)).toEqual([
      InvoiceType.TAX_INVOICE_RECEIPT,
      InvoiceType.CREDIT_NOTE,
    ]);
  });

  it('the order page lists the documents; the customer opens one with the order token only', async () => {
    const order = await paidOrder('doc');
    await owner.post(`/orders/${order.number}/refunds`, { amount: 10_000, reason: 'בדיקה' }).expect(200);
    await runJobs();
    const [invoice, note] = await invoices(order.id);

    const view = (await http().get(`/api/orders/${order.number}`).query({ t: order.publicToken }).expect(200))
      .body as OrderView;
    expect(view.invoices).toEqual([
      { id: invoice.id, type: 'tax_invoice_receipt', number: invoice.number, issuedAt: invoice.issuedAt.toISOString() },
      { id: note.id, type: 'credit_note', number: note.number, issuedAt: note.issuedAt.toISOString() },
    ]);

    const url = `/api/orders/${order.number}/invoices/${invoice.id}`;
    const res = await http().get(url).query({ t: order.publicToken }).expect(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-disposition']).toBe('inline');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain(invoice.number);
    expect(res.text).toContain('NESTO');
    expect(res.text).toContain(docDate(invoice.issuedAt));

    await http().get(url).expect(404);
    await http().get(url).query({ t: 'wrong' }).expect(404);
    // Another order's token, or this order's token with another order's invoice.
    const other = await paidOrder('doc-other');
    const otherInvoice = (await invoices(other.id))[0];
    await http().get(url).query({ t: other.publicToken }).expect(404);
    await http()
      .get(`/api/orders/${order.number}/invoices/${otherInvoice.id}`)
      .query({ t: order.publicToken })
      .expect(404);
    await http().get(`/api/orders/${order.number}/invoices/${NO_ID}`).query({ t: order.publicToken }).expect(404);
    await http().get(`/api/orders/${order.number}/invoices/not-a-uuid`).query({ t: order.publicToken }).expect(404);
    // The private folder is never served as media.
    await http().get(`/media/invoices/${invoice.number}.html`).expect(404);
    await http().get(`/media/private/invoices/${invoice.number}.html`).expect(404);
  });

  it('staff open a document with invoices.export only; the order detail lists the documents', async () => {
    const order = await paidOrder('admin');
    const [invoice] = await invoices(order.id);
    const url = `/invoices/${invoice.id}/document`;

    const res = await owner.get(url).expect(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['cache-control']).toBe('private, no-store');
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.text).toContain(invoice.number);
    await service.get(url).expect(403);
    await http().get(`/api/admin${url}`).expect(401);
    await owner.get(`/invoices/${NO_ID}/document`).expect(404);
    await owner.get('/invoices/not-a-uuid/document').expect(404);

    const detail = (await service.get(`/orders/${order.number}`).expect(200)).body as AdminOrderDetail;
    expect(detail.invoices).toEqual([
      { id: invoice.id, type: 'tax_invoice_receipt', number: invoice.number, issuedAt: invoice.issuedAt.toISOString() },
    ]);
  });
});
