import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { SupportTicketCreated } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { hashToken } from './../src/auth/crypto.js';
import { configureApp } from './../src/configure-app.js';
import { CustomerSessionService } from './../src/customers/customer-session.service.js';
import {
  DeliverySlotState,
  OrderShippingMethod,
  OrderStatus,
  SupportTicketType,
} from './../src/generated/prisma/client.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { deleteOrders, TEST_ORDERS } from './test-orders.js';

const ORIGIN = 'http://localhost:4200';
const DAY = 24 * 60 * 60_000;
const PHONE = '0501234567';
const RELAXED = 100_000;

// Returns, exchanges, damaged products and contact (spec §7.1, SRV-02, SRV-03, SRV-05).
describe('Support requests (e2e, SRV-02, SRV-03, SRV-05)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let throttle: WriteThrottle;
  const media = process.env.MEDIA_DIR!;
  let seq = 0;

  const http = () => request(app.getHttpServer() as App);
  const post = (path: string, body: object, cookie?: string) => {
    const req = http().post(`/api/support/${path}`).set('Origin', ORIGIN);
    if (cookie) req.set('Cookie', cookie);
    return req.send(body);
  };
  const cleanup = async () => {
    await prisma.supportTicket.deleteMany({});
    await prisma.outboxJob.deleteMany({});
    await prisma.notificationLog.deleteMany({});
    await deleteOrders(prisma, TEST_ORDERS);
    await prisma.customer.deleteMany({ where: { email: { endsWith: '@support.zz.test' } } });
  };

  const makeOrder = async (
    status: OrderStatus,
    opts: { deliveredAt?: Date | null; customerId?: string; quantity?: number } = {},
  ) => {
    const key = `sup-${++seq}-${Date.now()}`;
    return prisma.order.create({
      data: {
        publicToken: `zz-token-${key}`,
        status,
        customerId: opts.customerId,
        deliveredAt: opts.deliveredAt === undefined ? new Date(Date.now() - 3 * DAY) : opts.deliveredAt,
        contact: { fullName: `ZZ ${key}`, phone: PHONE, email: 'zz-buyer@example.test' },
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
        reservedUntil: new Date(),
        items: {
          create: [
            {
              sku: `ZZ-${key}`,
              modelName: 'ZZ ALBA',
              nameHe: 'ספה',
              optionLabels: ['בז'],
              unitPrice: 50_000,
              quantity: opts.quantity ?? 2,
              lineTotal: 100_000,
            },
          ],
        },
      },
      include: { items: true },
    });
  };
  type TestOrder = Awaited<ReturnType<typeof makeOrder>>;
  const ref = (order: TestOrder, phone = '050-123-4567') => ({ number: String(order.number), phone });
  const returnBody = (order: TestOrder, patch: object = {}) => ({
    order: ref(order),
    type: 'return',
    items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    reasonCode: 'changed_mind',
    note: 'לא מתאים לסלון',
    ...patch,
  });

  const photo = (width = 1200, height = 900) =>
    sharp({ create: { width, height, channels: 3, background: { r: 190, g: 170, b: 140 } } })
      .withExif({ IFD0: { Make: 'ZZCam' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1' } })
      .jpeg()
      .toBuffer();
  const damaged = (order: TestOrder | null, files: { data: Buffer; name: string }[], fields: object = {}) => {
    let req = http().post('/api/support/damaged').set('Origin', ORIGIN);
    const all: Record<string, string> = {
      ...(order
        ? { 'order[number]': String(order.number), 'order[phone]': PHONE, orderItemId: String(order.items[0].id) }
        : {}),
      description: 'הרגל של הספה נשברה בהובלה',
      ...fields,
    };
    for (const [k, v] of Object.entries(all)) req = req.field(k, v);
    for (const f of files) req = req.attach('photos', f.data, f.name);
    return req;
  };

  const jobsOf = (ticketId: string) =>
    prisma.outboxJob.findMany({ where: { dedupeKey: { endsWith: `:${ticketId}` } }, orderBy: { dedupeKey: 'asc' } });
  const ticketOf = async (res: request.Response) => {
    const { ticketNumber } = res.body as SupportTicketCreated;
    return prisma.supportTicket.findUniqueOrThrow({ where: { number: ticketNumber }, include: { attachments: true } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    throttle = app.get(WriteThrottle);
    await cleanup();
  });

  afterEach(() => {
    throttle.setLimit('support', RELAXED);
    throttle.setLimit('support_order', RELAXED);
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('order view fields for the forms', () => {
    it('a delivered order shows its lines ids, deliveredAt and returnUntil (delivery + the window)', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const res = await http().get(`/api/orders/${order.number}`).query({ t: order.publicToken }).expect(200);
      const settings = await prisma.storeSettings.findUnique({ where: { id: 1 } });
      const days = settings?.returnWindowDays ?? 14;
      expect(res.body.lines[0].orderItemId).toBe(order.items[0].id);
      expect(res.body.deliveredAt).toBe(order.deliveredAt!.toISOString());
      expect(res.body.returnUntil).toBe(new Date(order.deliveredAt!.getTime() + days * DAY).toISOString());
    });

    it('an order that is not delivered has null deliveredAt and returnUntil', async () => {
      const order = await makeOrder(OrderStatus.SHIPPED, { deliveredAt: null });
      const res = await http().get(`/api/orders/${order.number}`).query({ t: order.publicToken }).expect(200);
      expect(res.body.deliveredAt).toBeNull();
      expect(res.body.returnUntil).toBeNull();
    });
  });

  describe('return / exchange', () => {
    it('a delivered order within the window: 202 with a ticket number from 5001, both e-mails queued and sent', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const res = await post('returns', returnBody(order)).expect(202);
      expect(res.headers['cache-control']).toBe('no-store');
      const ticket = await ticketOf(res);
      expect(ticket.number).toBeGreaterThanOrEqual(5001);
      expect(ticket).toMatchObject({
        type: SupportTicketType.RETURN,
        status: 'NEW',
        orderId: order.id,
        customerId: null,
        phone: PHONE,
        email: 'zz-buyer@example.test',
        reasonCode: 'changed_mind',
        message: 'לא מתאים לסלון',
        items: [{ orderItemId: order.items[0].id, quantity: 1 }],
      });

      const jobs = await jobsOf(ticket.id);
      expect(jobs.map((j) => j.dedupeKey)).toEqual([
        `email.ticket_alert:${ticket.id}`,
        `email.ticket_received:${ticket.id}`,
      ]);
      await app.get(OutboxService).runDue(100);
      const logs = await prisma.notificationLog.findMany({ where: { template: { startsWith: 'ticket_' } } });
      const received = logs.find((l) => l.template === 'ticket_received')!;
      expect(received.status).toBe('SENT');
      expect(received.subject).toBe(`קיבלנו את פנייתך, מספר פנייה ${ticket.number}`);
      expect(received.recipientMasked).not.toContain('zz-buyer');
      const alert = logs.find((l) => l.template === 'ticket_alert')!;
      expect(alert.status).toBe('SENT');
      expect(alert.recipientMasked.endsWith('@example.test')).toBe(true);
      expect(alert.body).toContain(String(ticket.number));
      expect(alert.body).toContain(String(order.number));
    });

    it('an exchange of the whole line is accepted', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const res = await post(
        'returns',
        returnBody(order, { type: 'exchange', items: [{ orderItemId: order.items[0].id, quantity: 2 }] }),
      ).expect(202);
      expect((await ticketOf(res)).type).toBe(SupportTicketType.EXCHANGE);
    });

    it('before delivery → 409 not_delivered', async () => {
      const order = await makeOrder(OrderStatus.SHIPPED, { deliveredAt: null });
      const res = await post('returns', returnBody(order)).expect(409);
      expect(res.body.code).toBe('not_delivered');
      expect(res.body.messageHe).toBeTruthy();
    });

    it('after the window (store settings: 14 days) → 409 return_window_passed', async () => {
      expect((await prisma.storeSettings.findUniqueOrThrow({ where: { id: 1 } })).returnWindowDays).toBe(14);
      const order = await makeOrder(OrderStatus.DELIVERED, { deliveredAt: new Date(Date.now() - 15 * DAY) });
      expect((await post('returns', returnBody(order)).expect(409)).body.code).toBe('return_window_passed');
    });

    it('a wrong phone, an unknown number and a malformed number all get the same 404', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const wrong = await post('returns', returnBody(order, { order: ref(order, '0529999999') })).expect(404);
      const unknown = await post(
        'returns',
        returnBody(order, { order: { number: '2000000000', phone: PHONE } }),
      ).expect(404);
      const malformed = await post('returns', returnBody(order, { order: { number: 'abc', phone: PHONE } })).expect(
        404,
      );
      expect(wrong.body).toEqual(unknown.body);
      expect(malformed.body).toEqual(unknown.body);
      expect(wrong.body.code).toBe('not_found');
    });

    it('signed out without an order → 400 order', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      expect((await post('returns', returnBody(order, { order: null })).expect(400)).body.field).toBe('order');
    });

    it('a quantity above the ordered one → 400 items.0.quantity', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const res = await post(
        'returns',
        returnBody(order, { items: [{ orderItemId: order.items[0].id, quantity: 3 }] }),
      ).expect(400);
      expect(res.body).toMatchObject({ code: 'invalid_field', field: 'items.0.quantity' });
      expect(await prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
    });

    it('signed in: the customer’s own order without a phone; another order → the same 404', async () => {
      const customer = await prisma.customer.create({
        data: { fullName: 'ZZ לקוח', phone: '0541112233', email: `c${Date.now()}@support.zz.test` },
      });
      const cookie = `hg_customer=${await app.get(CustomerSessionService).start(customer.id)}`;
      const own = await makeOrder(OrderStatus.DELIVERED, { customerId: customer.id });
      const res = await post('returns', returnBody(own, { order: null }), cookie).expect(202);
      expect(await ticketOf(res)).toMatchObject({ orderId: own.id, customerId: customer.id });

      const other = await makeOrder(OrderStatus.DELIVERED);
      // Number + the right phone of a guest order is still not the signed-in customer's.
      expect((await post('returns', returnBody(other), cookie).expect(404)).body.code).toBe('not_found');
      expect((await post('returns', returnBody(other, { order: null }), cookie).expect(404)).body.code).toBe(
        'not_found',
      );

      // A ticket about an order belongs to the order's account, also when filed signed out with number + phone.
      const signedOut = await post('returns', returnBody(own)).expect(202);
      expect((await ticketOf(signedOut)).customerId).toBe(customer.id);
      // A contact ticket without an order takes the signed-in customer; with an order, the order's account (none).
      const contactBody = {
        fullName: 'ZZ לקוח',
        phone: PHONE,
        email: 'a@example.test',
        subject: 'נושא',
        message: 'הודעה ארוכה מספיק',
      };
      expect((await ticketOf(await post('contact', contactBody, cookie).expect(202))).customerId).toBe(customer.id);
      const aboutGuestOrder = await post(
        'contact',
        { ...contactBody, orderNumber: String(other.number) },
        cookie,
      ).expect(202);
      expect(await ticketOf(aboutGuestOrder)).toMatchObject({ orderId: other.id, customerId: null });
    });
  });

  describe('damaged product', () => {
    it('2 photos: stored privately as WebP without metadata, never under the public media URL', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED, { deliveredAt: new Date(Date.now() - 400 * DAY) });
      const res = await damaged(order, [
        { data: await photo(), name: 'a.jpg' },
        { data: await photo(2400, 1800), name: 'b.jpg' },
      ]).expect(202);
      const ticket = await ticketOf(res);
      expect(ticket).toMatchObject({
        type: SupportTicketType.DAMAGED,
        orderId: order.id,
        message: 'הרגל של הספה נשברה בהובלה',
        items: [{ orderItemId: order.items[0].id }],
      });
      expect(ticket.attachments).toHaveLength(2);

      const dir = join(media, 'private', 'support', ticket.id);
      expect(readdirSync(dir)).toHaveLength(2);
      expect(existsSync(join(media, 'public', 'support'))).toBe(false);
      for (const a of ticket.attachments) {
        expect(a.storageKey.startsWith(`support/${ticket.id}/`)).toBe(true);
        expect(a.mimeType).toBe('image/webp');
        const file = join(media, 'private', a.storageKey);
        const meta = await sharp(file).metadata();
        expect(meta.format).toBe('webp');
        expect(meta.width).toBeLessThanOrEqual(1600);
        expect(meta.exif).toBeUndefined();
        expect(a.size).toBeGreaterThan(0);
        await http().get(`/media/${a.storageKey}`).expect(404);
        await http().get(`/media/../private/${a.storageKey}`).expect(404);
      }
      expect((await jobsOf(ticket.id)).length).toBe(2);
    });

    it('a text file named .jpg → 400 photos, nothing saved', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const res = await damaged(order, [{ data: Buffer.from('not a photo at all'), name: 'fake.jpg' }]).expect(400);
      expect(res.body).toMatchObject({ code: 'invalid_field', field: 'photos' });
      expect(await prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
    });

    it('6 photos or none → 400 photos', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const one = await photo();
      const six = Array.from({ length: 6 }, (_, i) => ({ data: one, name: `p${i}.jpg` }));
      expect((await damaged(order, six).expect(400)).body.field).toBe('photos');
      expect((await damaged(order, []).expect(400)).body.field).toBe('photos');
      expect(await prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
    });

    it('a photo over 10 MB or a file under another field → 400 photos; another multipart problem → a plain 400', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const big = Buffer.alloc(10 * 1024 * 1024 + 1, 1);
      const tooLarge = await damaged(order, [{ data: big, name: 'big.jpg' }]).expect(400);
      expect(tooLarge.body).toMatchObject({ code: 'invalid_field', field: 'photos' });
      const otherField = await damaged(order, [])
        .attach('file', await photo(), 'a.jpg')
        .expect(400);
      expect(otherField.body.field).toBe('photos');
      const extra = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`x${i}`, 'v']));
      const tooManyFields = await damaged(order, [{ data: await photo(), name: 'a.jpg' }], extra).expect(400);
      expect(tooManyFields.body.field).toBeUndefined();
      expect(await prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
    });

    it('a small photo (400×300) is accepted', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      await damaged(order, [{ data: await photo(400, 300), name: 'small.jpg' }]).expect(202);
    });

    it('before delivery → 409 not_delivered', async () => {
      const order = await makeOrder(OrderStatus.SHIPPED, { deliveredAt: null });
      const res = await damaged(order, [{ data: await photo(), name: 'a.jpg' }]).expect(409);
      expect(res.body.code).toBe('not_delivered');
    });
  });

  describe('contact', () => {
    const contact = (patch: object = {}) => ({
      fullName: 'ZZ דנה כהן',
      phone: '050-7654321',
      email: 'Dana@Example.test',
      subject: 'שאלה על ספה',
      message: 'האם הספה מגיעה גם בצבע אפור?',
      ...patch,
    });

    it('opens a contact ticket with the contact snapshot and the order when the number exists', async () => {
      const order = await makeOrder(OrderStatus.PAID, { deliveredAt: null });
      const res = await post('contact', contact({ orderNumber: String(order.number) })).expect(202);
      const ticket = await ticketOf(res);
      expect(ticket).toMatchObject({
        type: SupportTicketType.CONTACT,
        fullName: 'ZZ דנה כהן',
        phone: '0507654321',
        email: 'dana@example.test',
        subject: 'שאלה על ספה',
        orderId: order.id,
      });
      expect((await jobsOf(ticket.id)).length).toBe(2);
    });

    it('an invalid e-mail → 400 email', async () => {
      expect((await post('contact', contact({ email: 'x@' })).expect(400)).body.field).toBe('email');
    });
  });

  describe('protection', () => {
    it('honeypot: 202 with an empty body, no ticket and no job (returns, damaged, contact)', async () => {
      const order = await makeOrder(OrderStatus.DELIVERED);
      const before = await prisma.supportTicket.count();
      const jobs = await prisma.outboxJob.count();
      const a = await post('returns', returnBody(order, { website: 'http://spam.test' })).expect(202);
      expect(a.body).toEqual({});
      const d = await damaged(order, [{ data: await photo(), name: 'a.jpg' }], { website: 'x' }).expect(202);
      expect(d.body).toEqual({});
      const c = await post('contact', { website: 'spam', fullName: 'x' }).expect(202);
      expect(c.body).toEqual({});
      expect(await prisma.supportTicket.count()).toBe(before);
      expect(await prisma.outboxJob.count()).toBe(jobs);
    });

    it('per IP: over the support limit → 429 with Retry-After', async () => {
      throttle.setLimit('support', 2);
      const body = {
        fullName: 'ZZ x',
        phone: PHONE,
        email: 'a@example.test',
        subject: 'נושא',
        message: 'הודעה ארוכה מספיק',
      };
      await post('contact', body).expect(202);
      await post('contact', body).expect(202);
      const res = await post('contact', body).expect(429);
      expect(res.body.code).toBe('too_many_requests');
      expect(res.headers['retry-after']).toBeDefined();
    });

    it('per order: a sixth request for one order → 429 even with a wrong phone', async () => {
      throttle.setLimit('support_order', 5);
      const order = await makeOrder(OrderStatus.DELIVERED);
      for (let i = 0; i < 5; i++)
        await post('returns', returnBody(order, { order: ref(order, '0529999999') })).expect(404);
      expect((await post('returns', returnBody(order)).expect(429)).body.code).toBe('too_many_requests');
      expect(await prisma.supportTicket.count({ where: { orderId: order.id } })).toBe(0);
    });

    it('a request from another origin → 403', async () => {
      await http().post('/api/support/contact').set('Origin', 'http://evil.test').send({}).expect(403);
    });
  });

  describe('delivery change request (spec §5.3)', () => {
    it('opens a delivery_change ticket with the customer’s note and keeps the attention note', async () => {
      const order = await makeOrder(OrderStatus.DELIVERY_SCHEDULED, { deliveredAt: null });
      const token = `zz-slot-${order.id}`;
      await prisma.deliverySlot.create({
        data: {
          orderId: order.id,
          date: new Date(Date.now() + 3 * DAY),
          windowFrom: '09:00',
          windowTo: '13:00',
          tokenHash: hashToken(token),
          state: DeliverySlotState.PROPOSED,
        },
      });
      await http()
        .post(`/api/delivery/${token}`)
        .set('Origin', ORIGIN)
        .send({ answer: 'change', note: 'רק אחרי הצהריים' })
        .expect(201);
      const row = await prisma.order.findUniqueOrThrow({ where: { id: order.id } });
      expect(row.attentionNote).toBe('הלקוח ביקש מועד אספקה אחר — רק אחרי הצהריים');
      const ticket = await prisma.supportTicket.findFirstOrThrow({ where: { orderId: order.id } });
      expect(ticket).toMatchObject({
        type: SupportTicketType.DELIVERY_CHANGE,
        message: 'רק אחרי הצהריים',
        phone: PHONE,
        email: 'zz-buyer@example.test',
      });
      expect((await jobsOf(ticket.id)).map((j) => j.type).sort()).toEqual([
        'email.ticket_alert',
        'email.ticket_received',
      ]);
    });
  });
});
