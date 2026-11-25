import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type {
  AdminTicketDetail,
  AdminTicketNewCount,
  AdminTicketPage,
  OneTimeLink,
  StoreSettingsView,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import {
  OrderShippingMethod,
  OrderStatus,
  SupportTicketStatus,
  SupportTicketType,
} from './../src/generated/prisma/client.js';
import { StorageProvider } from './../src/media/storage.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteOrders, TEST_ORDERS } from './test-orders.js';

const MINUTE = 60_000;
const BINARY = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

// The admin support inbox (spec §7.2, SRV-02, SRV-03, SRV-05): list, "new" counter, ticket page, notes, status,
// private photos, and the return window setting. Tickets are created straight in the database.
describe('Admin support inbox (e2e, SRV-02, SRV-03, SRV-05)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let storage: StorageProvider;
  let owner: AdminBrowser;
  /** customer_service: support.manage, orders.view and orders.manage. */
  let service: AdminBrowser;
  /** customer_service without support.manage (orders.manage only). */
  let ordersOnly: AdminBrowser;
  /** content_editor: no support or order permissions. */
  let editor: AdminBrowser;
  /** store_seller: orders.view only. */
  let seller: AdminBrowser;
  let seq = 0;
  const storedKeys: string[] = [];

  const http = () => request(app.getHttpServer() as App);

  const cleanup = async () => {
    await prisma.supportTicket.deleteMany({});
    await prisma.outboxJob.deleteMany({});
    await deleteOrders(prisma, TEST_ORDERS);
    await storage.remove(storedKeys.map((key) => ({ key, visibility: 'private' as const })));
    await prisma.storeSettings.update({ where: { id: 1 }, data: { returnWindowDays: 14 } });
  };

  const makeOrder = async () => {
    const key = `supadm-${++seq}-${Date.now()}`;
    return prisma.order.create({
      data: {
        publicToken: `zz-token-${key}`,
        status: OrderStatus.DELIVERED,
        deliveredAt: new Date(Date.now() - 2 * 24 * 60 * MINUTE),
        contact: { fullName: `ZZ ${key}`, phone: '0501234567', email: 'zz-buyer@example.test' },
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
              quantity: 2,
              lineTotal: 100_000,
            },
          ],
        },
      },
      include: { items: true },
    });
  };

  const makeTicket = (
    type: SupportTicketType,
    opts: { status?: SupportTicketStatus; createdAt?: Date; orderId?: string; items?: object; message?: string } = {},
  ) =>
    prisma.supportTicket.create({
      data: {
        type,
        status: opts.status,
        createdAt: opts.createdAt,
        orderId: opts.orderId ?? null,
        fullName: `ZZ פונה ${++seq}`,
        phone: '0501234567',
        email: 'zz-sender@example.test',
        subject: type === SupportTicketType.CONTACT ? 'שאלה על ספה' : null,
        message: opts.message ?? 'הודעה של הלקוח',
        ...(opts.items ? { items: opts.items } : {}),
      },
    });

  const photo = () =>
    sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 190, g: 170, b: 140 } } })
      .webp()
      .toBuffer();

  /** A damaged-product ticket with one stored photo, as the storefront form leaves it. */
  const damagedWithPhoto = async () => {
    const order = await makeOrder();
    const ticket = await makeTicket(SupportTicketType.DAMAGED, {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id }],
    });
    const data = await photo();
    const storageKey = `support/${ticket.id}/zz-photo-${seq}.webp`;
    await storage.put(storageKey, data, 'private');
    storedKeys.push(storageKey);
    const attachment = await prisma.ticketAttachment.create({
      data: { ticketId: ticket.id, storageKey, mimeType: 'image/webp', size: data.length },
    });
    return { order, ticket, attachment, data };
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    storage = app.get(StorageProvider);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: service } = await signInOwnerAnd(app, 'customer_service'));
    const invite = async (email: string, template: string, removedPermissions: string[] = []) => {
      const created = await owner
        .post('/users', { email, name: `צוות ${template}`, template, removedPermissions })
        .expect(201);
      return acceptAndSignIn(
        app,
        { email, password: 'pebble garden lantern ocean' },
        created.body.invite as OneTimeLink,
      );
    };
    ordersOnly = await invite('orders-only@example.test', 'customer_service', ['support.manage']);
    editor = await invite('editor@example.test', 'content_editor');
    seller = await invite('seller@example.test', 'store_seller');
  });

  beforeEach(() => prisma.supportTicket.deleteMany({}));

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('every inbox endpoint needs a session and support.manage', async () => {
    const { ticket, attachment } = await damagedWithPhoto();
    const urls = [
      '/support',
      '/support/count-new',
      `/support/${ticket.number}`,
      `/support/${ticket.number}/attachments/${attachment.id}`,
    ];
    for (const url of urls) {
      await http().get(`/api/admin${url}`).expect(401);
      for (const who of [editor, seller, ordersOnly]) await who.get(url).expect(403);
      await service.get(url).expect(200);
      await owner.get(url).expect(200);
    }
    for (const who of [editor, seller, ordersOnly]) {
      await who.post(`/support/${ticket.number}/status`, { status: 'closed' }).expect(403);
      await who.post(`/support/${ticket.number}/notes`, { body: 'הערה' }).expect(403);
    }
    // Writes come from the admin app only (SameOriginGuard).
    await service.agent.post(`/api/admin/support/${ticket.number}/notes`).send({ body: 'הערה' }).expect(403);
    await service.agent.post(`/api/admin/support/${ticket.number}/status`).send({ status: 'closed' }).expect(403);
    expect(await prisma.ticketNote.count()).toBe(0);
    expect((await prisma.supportTicket.findUniqueOrThrow({ where: { id: ticket.id } })).status).toBe('NEW');
  });

  it('lists newest first, 30 per page, with the row fields', async () => {
    const base = Date.now() - 60 * MINUTE;
    for (let i = 0; i < 31; i++)
      await makeTicket(SupportTicketType.CONTACT, { createdAt: new Date(base + i * MINUTE) });
    const page = (await service.get('/support').expect(200)).body as AdminTicketPage;
    expect(page).toMatchObject({ total: 31, page: 1, pageSize: 30 });
    expect(page.items).toHaveLength(30);
    const times = page.items.map((t) => Date.parse(t.createdAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(page.items[0]).toMatchObject({
      type: 'contact',
      status: 'new',
      phone: '0501234567',
      subject: 'שאלה על ספה',
      orderNumber: null,
      attachmentCount: 0,
    });
    expect(page.items[0].number).toBeGreaterThanOrEqual(5001);
    expect(page.items[0]).not.toHaveProperty('email');
    const second = (await service.get('/support?page=2').expect(200)).body as AdminTicketPage;
    expect(second.items).toHaveLength(1);
    expect(second.items[0].number).toBe(Math.min(...page.items.map((t) => t.number)) - 1);
  });

  it('filters by type and status; refuses unknown filters and pages', async () => {
    const order = await makeOrder();
    await makeTicket(SupportTicketType.RETURN, {
      orderId: order.id,
      items: [{ orderItemId: order.items[0].id, quantity: 1 }],
    });
    await makeTicket(SupportTicketType.RETURN, { status: SupportTicketStatus.CLOSED });
    await makeTicket(SupportTicketType.EXCHANGE, { status: SupportTicketStatus.IN_PROGRESS });
    await makeTicket(SupportTicketType.CONTACT);
    await makeTicket(SupportTicketType.DELIVERY_CHANGE, { status: SupportTicketStatus.IN_PROGRESS });

    const list = async (query: string) =>
      ((await service.get(`/support${query}`).expect(200)).body as AdminTicketPage).items.map((t) => [
        t.type,
        t.status,
      ]);
    expect(await list('?type=return')).toEqual([
      ['return', 'closed'],
      ['return', 'new'],
    ]);
    expect(await list('?status=in_progress')).toEqual([
      ['delivery_change', 'in_progress'],
      ['exchange', 'in_progress'],
    ]);
    expect(await list('?type=return&status=new')).toEqual([['return', 'new']]);
    expect(await list('?type=damaged')).toEqual([]);
    expect(await list('?type=&status=')).toHaveLength(5);
    const linked = ((await service.get('/support?type=return&status=new').expect(200)).body as AdminTicketPage)
      .items[0];
    expect(linked.orderNumber).toBe(order.number);

    for (const [query, field] of [
      ['?type=refund', 'type'],
      ['?type=RETURN', 'type'],
      ['?status=open', 'status'],
      ['?page=0', 'page'],
      ['?page=abc', 'page'],
      ['?page=1.5', 'page'],
    ]) {
      const res = await service.get(`/support${query}`).expect(400);
      expect(res.body).toMatchObject({ code: 'invalid_input', field });
    }
  });

  it('counts the tickets in status new', async () => {
    await makeTicket(SupportTicketType.CONTACT);
    await makeTicket(SupportTicketType.RETURN);
    await makeTicket(SupportTicketType.EXCHANGE, { status: SupportTicketStatus.IN_PROGRESS });
    await makeTicket(SupportTicketType.DAMAGED, { status: SupportTicketStatus.CLOSED });
    const res = await service.get('/support/count-new').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body as AdminTicketNewCount).toEqual({ count: 2 });
  });

  it('shows one ticket: contact, order link, lines, photos and notes; 404 for unknown or malformed numbers', async () => {
    const { order, ticket, attachment } = await damagedWithPhoto();
    const detail = (await service.get(`/support/${ticket.number}`).expect(200)).body as AdminTicketDetail;
    expect(detail).toMatchObject({
      number: ticket.number,
      type: 'damaged',
      status: 'new',
      contact: { fullName: ticket.fullName, phone: '0501234567', email: 'zz-sender@example.test' },
      message: 'הודעה של הלקוח',
      reasonCode: null,
      orderNumber: order.number,
      hasAccount: false,
      items: [
        {
          orderItemId: order.items[0].id,
          quantity: null,
          sku: order.items[0].sku,
          modelName: 'ZZ ALBA',
          nameHe: 'ספה',
          optionLabels: ['בז'],
          orderedQuantity: 2,
        },
      ],
      attachments: [{ id: attachment.id, mimeType: 'image/webp', size: attachment.size }],
      notes: [],
    });
    // The private storage key is never shown.
    expect(JSON.stringify(detail)).not.toContain('support/');

    for (const bad of ['99999999', 'abc', '0', '99999999999', '5001.5'])
      await service.get(`/support/${bad}`).expect(404);
  });

  it('adds notes with author and time (trimmed, 1–2000 characters) and audits them without the text', async () => {
    const ticket = await makeTicket(SupportTicketType.CONTACT);
    const res = await service.post(`/support/${ticket.number}/notes`, { body: '  התקשרתי ללקוחה, תחזור מחר  ' });
    expect(res.status).toBe(201);
    const detail = res.body as AdminTicketDetail;
    expect(detail.notes).toHaveLength(1);
    expect(detail.notes[0]).toMatchObject({ body: 'התקשרתי ללקוחה, תחזור מחר', author: { name: 'עורך תוכן' } });
    expect(Math.abs(Date.parse(detail.notes[0].createdAt) - Date.now())).toBeLessThan(MINUTE);

    await owner.post(`/support/${ticket.number}/notes`, { body: 'א'.repeat(2000) }).expect(201);
    const both = (await service.get(`/support/${ticket.number}`).expect(200)).body as AdminTicketDetail;
    expect(both.notes.map((n) => n.author.name)).toEqual(['עורך תוכן', 'בעלת העסק']);

    for (const body of [{ body: '' }, { body: '   ' }, { body: 'א'.repeat(2001) }, { body: 5 }, {}]) {
      const bad = await service.post(`/support/${ticket.number}/notes`, body).expect(400);
      expect(bad.body).toMatchObject({ code: 'invalid_input', field: 'body' });
    }
    await service.post('/support/99999999/notes', { body: 'הערה' }).expect(404);
    expect(await prisma.ticketNote.count()).toBe(2);

    const audit = await prisma.auditLog.findMany({ where: { action: 'support.note' }, orderBy: { id: 'asc' } });
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ entityType: 'support_ticket', entityId: String(ticket.number) });
    expect(JSON.stringify(audit.map((a) => [a.before, a.after]))).not.toContain('התקשרתי');
  });

  it('changes the status (any direction), audits each change, refuses unknown statuses', async () => {
    const ticket = await makeTicket(SupportTicketType.RETURN);
    const moved = (await service.post(`/support/${ticket.number}/status`, { status: 'in_progress' }).expect(200))
      .body as AdminTicketDetail;
    expect(moved.status).toBe('in_progress');
    await service.post(`/support/${ticket.number}/status`, { status: 'closed' }).expect(200);
    const reopened = (await owner.post(`/support/${ticket.number}/status`, { status: 'new' }).expect(200))
      .body as AdminTicketDetail;
    expect(reopened.status).toBe('new');
    // The same status again changes nothing and writes no audit entry.
    await owner.post(`/support/${ticket.number}/status`, { status: 'new' }).expect(200);

    const audit = await prisma.auditLog.findMany({ where: { action: 'support.status' }, orderBy: { id: 'asc' } });
    expect(audit.map((a) => [a.before, a.after])).toEqual([
      [{ status: 'new' }, { status: 'in_progress' }],
      [{ status: 'in_progress' }, { status: 'closed' }],
      [{ status: 'closed' }, { status: 'new' }],
    ]);
    expect(audit[0]).toMatchObject({ entityType: 'support_ticket', entityId: String(ticket.number) });

    for (const body of [{ status: 'open' }, { status: 'NEW' }, {}, { status: null }]) {
      const bad = await service.post(`/support/${ticket.number}/status`, body).expect(400);
      expect(bad.body).toMatchObject({ code: 'invalid_input', field: 'status' });
    }
    await service.post('/support/99999999/status', { status: 'closed' }).expect(404);
  });

  it('streams a photo privately: the right type, no-store, only an attachment of that ticket', async () => {
    const first = await damagedWithPhoto();
    const second = await damagedWithPhoto();
    const res = await service
      .get(`/support/${first.ticket.number}/attachments/${first.attachment.id}`)
      .buffer(true)
      .parse(BINARY)
      .expect(200);
    expect(res.headers['content-type']).toBe('image/webp');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // Its own policy wins over the API-wide default-src 'none'; frame-ancestors 'none' (NFR-07).
    expect(res.headers['content-security-policy']).toBe("default-src 'none'; img-src 'self'");
    expect(Buffer.compare(res.body as Buffer, first.data)).toBe(0);

    // Another ticket's photo through this ticket's URL, unknown and malformed ids: one 404.
    await service.get(`/support/${first.ticket.number}/attachments/${second.attachment.id}`).expect(404);
    await service.get(`/support/${first.ticket.number}/attachments/99999999`).expect(404);
    await service.get(`/support/${first.ticket.number}/attachments/..%2F..%2Fsecret`).expect(404);
    await service.get(`/support/${first.ticket.number}/attachments/1e3`).expect(404);
    // The row exists but the file is gone: 404, not 500.
    await storage.remove([{ key: second.attachment.storageKey, visibility: 'private' }]);
    await service.get(`/support/${second.ticket.number}/attachments/${second.attachment.id}`).expect(404);
    // Photos are never public at /media.
    await http().get(`/media/${first.attachment.storageKey}`).expect(404);
  });

  describe('return window setting (Super Admin or orders.manage)', () => {
    it('reads and saves the days with orders.manage; audited; 1–60 whole days only', async () => {
      await http().get('/api/admin/settings/store').expect(401);
      for (const who of [editor, seller]) {
        await who.get('/settings/store').expect(403);
        await who.put('/settings/store', { returnWindowDays: 20 }).expect(403);
      }
      expect((await owner.get('/settings/store').expect(200)).body as StoreSettingsView).toEqual({
        returnWindowDays: 14,
      });
      const saved = await ordersOnly.put('/settings/store', { returnWindowDays: 30 }).expect(200);
      expect(saved.body as StoreSettingsView).toEqual({ returnWindowDays: 30 });
      expect((await service.get('/settings/store').expect(200)).body).toEqual({ returnWindowDays: 30 });
      await owner.put('/settings/store', { returnWindowDays: 60 }).expect(200);
      await owner.put('/settings/store', { returnWindowDays: 1 }).expect(200);

      const audit = await prisma.auditLog.findMany({ where: { action: 'settings.store' }, orderBy: { id: 'asc' } });
      expect(audit.map((a) => [a.before, a.after])).toEqual([
        [{ returnWindowDays: 14 }, { returnWindowDays: 30 }],
        [{ returnWindowDays: 30 }, { returnWindowDays: 60 }],
        [{ returnWindowDays: 60 }, { returnWindowDays: 1 }],
      ]);

      for (const body of [
        { returnWindowDays: 0 },
        { returnWindowDays: 61 },
        { returnWindowDays: 1.5 },
        { returnWindowDays: '20' },
        { returnWindowDays: null },
        {},
      ]) {
        const bad = await owner.put('/settings/store', body).expect(400);
        expect(bad.body).toMatchObject({ code: 'invalid_input', field: 'returnWindowDays' });
      }
      await owner.agent.put('/api/admin/settings/store').send({ returnWindowDays: 20 }).expect(403);
      expect((await prisma.storeSettings.findUniqueOrThrow({ where: { id: 1 } })).returnWindowDays).toBe(1);
    });
  });
});
