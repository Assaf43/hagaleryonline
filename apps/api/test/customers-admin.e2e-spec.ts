import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { CodeTemplateOption, CustomerPage, CustomerProfile, OneTimeLink } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import {
  ConsentAction,
  DiscountType,
  MarketingConsentSource,
  MarketingStatus,
  OrderShippingMethod,
  OrderStatus,
  PromotionKind,
  PromotionTarget,
} from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { issuePersonalCode } from './../src/promotions/personal-codes.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import { deleteMarketingContacts } from './test-marketing.js';
import { deleteOrders } from './test-orders.js';

const DOMAIN = '@custadmin.e2e.test';
const DAY = 24 * 60 * 60_000;

// Admin "לקוחות" (Phase 7c, spec §4.5, CLB-09): list, search and profile. Customers and orders are made directly in the
// e2e database.
describe('Admin customers (e2e, CLB-09)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  /** customer_service: customers.view, no club.manage. */
  let service: AdminBrowser;
  /** content_editor: no customer permissions. */
  let editor: AdminBrowser;
  let seq = 0;
  /** A phone no other file uses: 05 + 88 + 4 clock digits + 2 sequence digits. */
  const phone = () => `0588${String(Date.now() % 10_000).padStart(4, '0')}${String(++seq % 100).padStart(2, '0')}`;

  const cleanup = async () => {
    await deleteOrders(prisma);
    await prisma.personalCode.deleteMany();
    await prisma.promotion.deleteMany();
    await prisma.customer.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await prisma.customer.deleteMany({ where: { fullName: { startsWith: 'ZZCA' } } });
    await deleteMarketingContacts(prisma, { email: { endsWith: DOMAIN } });
  };

  const makeOrder = (key: string, customerId: string | null, status: OrderStatus = OrderStatus.PAID) =>
    prisma.order.create({
      data: {
        publicToken: `zz-ca-${key}`,
        status,
        customerId,
        contact: { fullName: `ZZ ${key}`, phone: '0501234567', email: 'zz@example.test' },
        address: { localityId: 5000, localityNameHe: 'תל אביב - יפו', street: 'הרצל', houseNumber: '1' },
        method: OrderShippingMethod.CURBSIDE,
        shippingTotal: 15_000,
        shippingLines: [{ labelHe: 'משלוח', amount: 15_000 }],
        subtotal: 100_000,
        total: 115_000,
        deliveryEstimate: { fulfillment: 'in_stock', leadTimeDays: 3 },
        paymentProvider: 'sandbox',
        shippingProvider: 'manual',
        reservedUntil: new Date(Date.now() + 20 * 60_000),
      },
    });

  const list = async (b: AdminBrowser, query: string) => {
    const res = await b.get(`/customers${query}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as CustomerPage;
  };

  let dana: { id: string; phone: string; email: string };
  let danaOrder: number;
  let guestOrder: number;
  let storeCustomer: { id: string; phone: string };
  let sellerId: number;
  let productId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: service } = await signInOwnerAnd(app, 'customer_service'));
    const editorUser = { email: 'editor@example.test', password: 'pebble garden lantern ocean' };
    const made = await owner
      .post('/users', { email: editorUser.email, name: 'עורך', template: 'content_editor' })
      .expect(201);
    editor = await acceptAndSignIn(app, editorUser, made.body.invite as OneTimeLink);
    sellerId = (await prisma.adminUser.findFirstOrThrow({ where: { email: 'owner@example.test' } })).id;

    await prisma.product.deleteMany({ where: { modelName: 'ZZCUSTADM' } });
    await prisma.category.deleteMany({ where: { slug: 'zz-custadm' } });
    const category = await prisma.category.create({
      data: {
        slug: 'zz-custadm',
        nameHe: 'בדיקת לקוחות',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    const product = await prisma.product.create({
      data: { slug: 'zz-custadm-lamp', modelName: 'ZZCUSTADM', nameHe: 'מנורת לקוחות', categoryId: category.id },
    });
    productId = product.id;
    await app.get(CacheStore).invalidate('catalog:');

    const email = `dana.zz${DOMAIN}`;
    const created = await prisma.customer.create({
      data: {
        fullName: 'ZZCA דנה כהן',
        phone: phone(),
        email,
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });
    dana = { id: created.id, phone: created.phone, email };
    danaOrder = (await makeOrder('own', created.id)).number;
    // A guest order with the very same contact details: never shown on the account (decision 77).
    guestOrder = (await makeOrder('guest', null)).number;
    await prisma.customerFavorite.create({ data: { customerId: created.id, productId } });

    const quick = await prisma.customer.create({
      data: {
        fullName: 'ZZCA רון לוי',
        phone: phone(),
        email: null,
        phoneVerifiedAt: new Date(),
        createdVia: 'STORE',
        createdBySellerId: sellerId,
      },
    });
    storeCustomer = { id: quick.id, phone: quick.phone };

    const contact = await prisma.marketingContact.create({
      data: {
        email,
        customerId: created.id,
        status: MarketingStatus.SUBSCRIBED,
        source: MarketingConsentSource.SIGNUP,
        consentAt: new Date(),
        confirmTokenHash: 'zz-secret-confirm-hash',
        unsubscribeTokenHash: 'zz-secret-unsubscribe-hash',
      },
    });
    await prisma.marketingConsentEvent.create({
      data: {
        contactId: contact.id,
        action: ConsentAction.CONFIRMED,
        source: MarketingConsentSource.SIGNUP,
        textVersion: '2026-11-16',
        actorCustomerId: created.id,
        ip: '203.0.113.7',
        at: new Date(Date.now() - DAY),
      },
    });
    await prisma.marketingConsentEvent.create({
      data: {
        contactId: contact.id,
        action: ConsentAction.WITHDRAWN,
        source: MarketingConsentSource.ACCOUNT,
        actorCustomerId: created.id,
        ip: '203.0.113.7',
        at: new Date(),
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await prisma.product.deleteMany({ where: { modelName: 'ZZCUSTADM' } });
    await prisma.category.deleteMany({ where: { slug: 'zz-custadm' } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  it('needs customers.view: a content editor is refused', async () => {
    await editor.get('/customers').expect(403);
    await editor.get(`/customers/${dana.id}`).expect(403);
    await editor.get('/customers/code-templates').expect(403);
    await service.get('/customers/code-templates').expect(403);
    await service.get('/customers').expect(200);
  });

  it('lists customers newest first with the way they were created and their order count', async () => {
    const page = await list(service, '?q=ZZCA');
    expect(page.total).toBe(2);
    expect(page.page).toBe(1);
    expect(page.items.map((c) => c.fullName)).toEqual(['ZZCA רון לוי', 'ZZCA דנה כהן']);
    expect(page.items[0]).toMatchObject({ id: storeCustomer.id, createdVia: 'store', email: null, orderCount: 0 });
    expect(page.items[1]).toMatchObject({
      id: dana.id,
      createdVia: 'web',
      email: dana.email,
      phone: dana.phone,
      orderCount: 1,
    });
  });

  it('searches by name, by phone in any written form, by e-mail in any case and by order number', async () => {
    const ids = async (q: string) => (await list(service, `?q=${encodeURIComponent(q)}`)).items.map((c) => c.id);
    expect(await ids('דנה כהן')).toEqual([dana.id]);
    expect(await ids(dana.phone)).toEqual([dana.id]);
    expect(await ids(dana.phone.slice(0, 3) + '-' + dana.phone.slice(3))).toEqual([dana.id]);
    expect(await ids(`+972${dana.phone.slice(1)}`)).toEqual([dana.id]);
    expect(await ids(dana.email.toUpperCase())).toEqual([dana.id]);
    expect(await ids(String(danaOrder))).toEqual([dana.id]);
    // A guest order belongs to no account: its number finds nobody.
    expect(await ids(String(guestOrder))).toEqual([]);
    expect(await ids('אין-כזה-לקוח')).toEqual([]);
    // A seller's quick account has a phone and no e-mail.
    expect(await ids(storeCustomer.phone)).toEqual([storeCustomer.id]);
  });

  it('pages the list and refuses a bad page or a too long search', async () => {
    const second = await list(service, '?q=ZZCA&page=2');
    expect(second.items).toEqual([]);
    expect(second.total).toBe(2);
    expect((await service.get('/customers?page=0').expect(400)).body).toMatchObject({ field: 'page' });
    expect((await service.get('/customers?page=x').expect(400)).body).toMatchObject({ field: 'page' });
    expect((await service.get(`/customers?q=${'a'.repeat(101)}`).expect(400)).body).toMatchObject({ field: 'q' });
    const all = await list(service, '');
    expect(all.pageSize).toBe(30);
  });

  it('shows the profile: details, own orders only, favorites, interests, consent history and codes', async () => {
    const t = await prisma.promotion.create({
      data: {
        name: 'ZZ קוד פרופיל',
        kind: PromotionKind.PERSONAL_TEMPLATE,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.ORDER,
        validityDays: 30,
      },
    });
    const issued = await issuePersonalCode(prisma, {
      templateId: t.id,
      customerId: dana.id,
      issuedById: sellerId,
      now: new Date(),
    });
    const auditBefore = await prisma.auditLog.count();

    const res = await service.get(`/customers/${dana.id}`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const profile = res.body as CustomerProfile;
    expect(profile).toMatchObject({
      id: dana.id,
      fullName: 'ZZCA דנה כהן',
      phone: dana.phone,
      phoneVerified: true,
      email: dana.email,
      emailVerified: true,
      createdVia: 'web',
      createdBySeller: null,
      orderCount: 1,
    });
    expect(profile.orders).toEqual([
      expect.objectContaining({ number: danaOrder, status: 'paid', total: 115_000, channel: 'web' }),
    ]);
    expect(JSON.stringify(profile)).not.toContain(String(guestOrder));
    expect(profile.favorites).toEqual([
      expect.objectContaining({ productId, modelName: 'ZZCUSTADM', nameHe: 'מנורת לקוחות' }),
    ]);
    expect(profile.interests).toEqual([{ slug: 'zz-custadm', nameHe: 'בדיקת לקוחות' }]);
    expect(profile.consent.contact).toMatchObject({ status: 'subscribed', source: 'signup', unsubscribedAt: null });
    expect(profile.consent.history.map((e) => [e.action, e.source, e.actor])).toEqual([
      ['withdrawn', 'account', 'customer'],
      ['confirmed', 'signup', 'customer'],
    ]);
    expect(profile.consent.history[1].textVersion).toBe('2026-11-16');
    expect(profile.codes).toEqual([
      expect.objectContaining({ code: issued.code, labelHe: 'ZZ קוד פרופיל', status: 'active', discountValue: 10 }),
    ]);
    // No token, hash or IP ever leaves the server; a read writes no audit entry.
    const text = JSON.stringify(profile);
    for (const secret of ['zz-secret', 'Hash', '203.0.113.7', 'token']) expect(text, secret).not.toContain(secret);
    expect(await prisma.auditLog.count()).toBe(auditBefore);
  });

  it('a seller quick account shows who opened it, no e-mail, and an empty history', async () => {
    const profile = (await service.get(`/customers/${storeCustomer.id}`).expect(200)).body as CustomerProfile;
    expect(profile).toMatchObject({
      createdVia: 'store',
      email: null,
      emailVerified: false,
      createdBySeller: { id: sellerId, name: 'בעלת העסק' },
      orders: [],
      orderCount: 0,
      favorites: [],
      interests: [],
      codes: [],
    });
    expect(profile.consent).toEqual({ contact: null, history: [] });
  });

  it('answers 404 for an unknown customer and for an id that is no uuid', async () => {
    await service.get('/customers/00000000-0000-4000-8000-000000000000').expect(404);
    await service.get('/customers/not-a-uuid').expect(404);
  });

  it('offers the active personal-code templates to club.manage only, never an ended or inactive one', async () => {
    const make = (name: string, extra: Record<string, unknown> = {}) =>
      prisma.promotion.create({
        data: {
          name,
          kind: PromotionKind.PERSONAL_TEMPLATE,
          discountType: DiscountType.FIXED,
          value: 20_000,
          minSubtotal: 100_000,
          target: PromotionTarget.ORDER,
          validityDays: 14,
          ...extra,
        },
      });
    const live = await make('ZZ תבנית פעילה');
    await make('ZZ תבנית כבויה', { active: false });
    await make('ZZ תבנית שהסתיימה', { endsAt: new Date(Date.now() - DAY) });
    await prisma.promotion.create({
      data: {
        name: 'ZZ קופון',
        kind: PromotionKind.COUPON,
        code: 'ZZCUSTCOUPON',
        discountType: DiscountType.PERCENT,
        value: 5,
        target: PromotionTarget.ORDER,
      },
    });
    const res = await owner.get('/customers/code-templates').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const options = (res.body as CodeTemplateOption[]).filter((o) => o.name.startsWith('ZZ תבנית'));
    expect(options).toEqual([
      {
        id: live.id,
        name: 'ZZ תבנית פעילה',
        discountType: 'fixed',
        value: 20_000,
        minSubtotal: 100_000,
        validityDays: 14,
      },
    ]);
  });
});
