import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { PERMISSION_TEMPLATES } from '@hg/models';
import type { AdminPromotion, AdminPromotionInput, AuditPage, PromotionCategoryOption } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const STOREFRONT = 'http://localhost:4200';

// Runs against the e2e test database. Everything this file creates is named "ZZ…" and removed again.
describe('Promotions admin (e2e, ADM-05, spec §6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let parentCategory: number;
  let subCategory: number;
  let productId: number;

  const cleanup = async () => {
    await prisma.promotion.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZPADMIN' } } });
    await prisma.category.deleteMany({ where: { slug: 'zz-padmin-sub' } });
    await prisma.category.deleteMany({ where: { slug: 'zz-padmin' } });
  };

  const coupon = (over: Partial<AdminPromotionInput> = {}): AdminPromotionInput => ({
    name: 'ZZ קופון חורף',
    kind: 'coupon',
    code: 'ZZWINTER',
    discountType: 'percent',
    value: 10,
    target: 'order',
    targetIds: [],
    minSubtotal: 0,
    startsAt: null,
    endsAt: null,
    usageLimit: 50,
    active: true,
    ...over,
  });
  const automatic = (over: Partial<AdminPromotionInput> = {}): AdminPromotionInput =>
    coupon({ name: 'ZZ מבצע ספות', kind: 'automatic', code: null, usageLimit: null, ...over });
  const create = async (input: AdminPromotionInput) =>
    (await owner.post('/promotions', input).expect(201)).body as AdminPromotion;
  const audit = async () => ((await owner.get('/audit?entityType=promotion').expect(200)).body as AuditPage).items;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    const parent = await prisma.category.create({ data: { slug: 'zz-padmin', nameHe: 'בדיקת מבצעים באדמין' } });
    const sub = await prisma.category.create({
      data: { slug: 'zz-padmin-sub', nameHe: 'תת בדיקה', parentId: parent.id },
    });
    parentCategory = parent.id;
    subCategory = sub.id;
    const product = await prisma.product.create({
      data: {
        slug: 'zz-padmin-sofa',
        modelName: 'ZZPADMIN',
        nameHe: 'ספת בדיקה',
        categoryId: sub.id,
        variants: {
          create: [
            { sku: 'ZZPADMIN-1', price: 100_000, stock: 5, widthCm: 200, depthCm: 90, heightCm: 80, leadTimeDays: 7 },
          ],
        },
      },
    });
    productId = product.id;
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('needs promotions.manage, which the manager template has', async () => {
    expect(PERMISSION_TEMPLATES.find((t) => t.code === 'manager')?.permissions).toContain('promotions.manage');
    await editor.get('/promotions').expect(403);
    await editor.get('/promotions/categories').expect(403);
    await editor.post('/promotions', coupon()).expect(403);
    await editor.put('/promotions/1', coupon()).expect(403);
    await editor.post('/promotions/1/deactivate').expect(403);
  });

  it('creates a coupon with a normalized code and audits it', async () => {
    const created = await create(coupon({ code: ' zzWinter‏ ' }));
    expect(created).toMatchObject({
      name: 'ZZ קופון חורף',
      kind: 'coupon',
      code: 'ZZWINTER',
      discountType: 'percent',
      value: 10,
      target: 'order',
      targets: [],
      usageLimit: 50,
      usedCount: 0,
      active: true,
    });
    const entry = (await audit()).find((e) => e.action === 'promotion.create' && e.entityId === String(created.id));
    expect(entry).toMatchObject({ before: null, entityLabel: 'ZZ קופון חורף' });
    expect(entry?.after).toMatchObject({ שם: 'ZZ קופון חורף', סוג: 'קופון', קוד: 'ZZWINTER', הנחה: '10%' });
  });

  it('creates an automatic promotion on categories and products, and lists everything with targets and uses', async () => {
    const start = '2026-12-01T22:00:00.000Z';
    const end = '2026-12-31T21:59:59.999Z';
    const onCategory = await create(
      automatic({
        target: 'categories',
        targetIds: [parentCategory],
        discountType: 'fixed',
        value: 15_000,
        minSubtotal: 200_000,
        startsAt: start,
        endsAt: end,
      }),
    );
    expect(onCategory).toMatchObject({
      code: null,
      usageLimit: null,
      value: 15_000,
      minSubtotal: 200_000,
      startsAt: start,
      endsAt: end,
      targets: [{ id: parentCategory, nameHe: 'בדיקת מבצעים באדמין', modelName: null }],
    });
    const onProduct = await create(automatic({ name: 'ZZ מבצע מוצר', target: 'products', targetIds: [productId] }));
    expect(onProduct.targets).toEqual([
      { id: productId, nameHe: 'ספת בדיקה', modelName: 'ZZPADMIN', active: true, thumbnailUrl: null },
    ]);

    await prisma.promotion.update({ where: { id: onProduct.id }, data: { usedCount: 3 } });
    const list = (await owner.get('/promotions').expect(200)).body as AdminPromotion[];
    const ids = list.map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining([onCategory.id, onProduct.id]));
    // Newest first.
    expect(ids.indexOf(onProduct.id)).toBeLessThan(ids.indexOf(onCategory.id));
    expect(list.find((p) => p.id === onProduct.id)).toMatchObject({ usedCount: 3, usageLimit: null });

    const one = (await owner.get(`/promotions/${onCategory.id}`).expect(200)).body as AdminPromotion;
    expect(one).toEqual(onCategory);
    await owner.get('/promotions/99999999').expect(404);
  });

  it('lists every category in tree order for the picker', async () => {
    const options = (await owner.get('/promotions/categories').expect(200)).body as PromotionCategoryOption[];
    const parent = options.findIndex((c) => c.id === parentCategory);
    const sub = options.findIndex((c) => c.id === subCategory);
    expect(options[parent]).toEqual({ id: parentCategory, nameHe: 'בדיקת מבצעים באדמין', depth: 0 });
    expect(options[sub]).toEqual({ id: subCategory, nameHe: 'תת בדיקה', depth: 1 });
    expect(sub).toBe(parent + 1);
  });

  it('refuses invalid promotions with the field at fault, and creates nothing', async () => {
    const before = await prisma.promotion.count();
    // A code no other coupon has, so only the field at fault answers.
    const fresh = (over: Partial<AdminPromotionInput> = {}) => coupon({ code: 'ZZFRESH', ...over });
    const cases: [AdminPromotionInput | Record<string, unknown>, string][] = [
      [fresh({ name: '  ' }), 'name'],
      [{ ...fresh(), kind: 'gift' }, 'kind'],
      [fresh({ code: null }), 'code'],
      [fresh({ code: '  ' }), 'code'],
      [fresh({ code: 'SAVE 10' }), 'code'],
      [fresh({ code: 'X'.repeat(65) }), 'code'],
      [automatic({ code: 'ZZAUTO' }), 'code'],
      [automatic({ usageLimit: 10 }), 'usageLimit'],
      [fresh({ usageLimit: 0 }), 'usageLimit'],
      [fresh({ value: 0 }), 'value'],
      [fresh({ value: 101 }), 'value'],
      [fresh({ value: 12.5 }), 'value'],
      [fresh({ discountType: 'fixed', value: 0 }), 'value'],
      [fresh({ minSubtotal: -1 }), 'minSubtotal'],
      [fresh({ target: 'order', targetIds: [parentCategory] }), 'targetIds'],
      [fresh({ target: 'categories', targetIds: [] }), 'targetIds'],
      [fresh({ target: 'categories', targetIds: [99_999_999] }), 'targetIds'],
      [fresh({ target: 'products', targetIds: [99_999_999] }), 'targetIds'],
      [fresh({ target: 'products', targetIds: [productId, productId] }), 'targetIds'],
      [fresh({ startsAt: 'tomorrow' }), 'startsAt'],
      // Real calendar times between 2000 and 2100 only.
      [fresh({ startsAt: '2026-02-31T10:00:00.000Z' }), 'startsAt'],
      [fresh({ startsAt: '2026-12-01T24:00:00.000Z' }), 'startsAt'],
      [fresh({ endsAt: '0000-01-01T00:00:00.000Z' }), 'endsAt'],
      [fresh({ endsAt: '1999-12-31T23:00:00.000Z' }), 'endsAt'],
      [fresh({ endsAt: '2101-01-01T00:00:00+02:00' }), 'endsAt'],
      // Fixed amounts and minimums in whole shekels.
      [fresh({ discountType: 'fixed', value: 15_050 }), 'value'],
      [fresh({ minSubtotal: 200_050 }), 'minSubtotal'],
      [fresh({ startsAt: '2026-12-02T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' }), 'endsAt'],
      [fresh({ startsAt: '2026-12-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' }), 'endsAt'],
      [{ ...fresh(), active: 'yes' }, 'active'],
    ];
    for (const [body, field] of cases) {
      const res = await owner.post('/promotions', body);
      expect({ status: res.status, body: res.body as unknown }, JSON.stringify(body)).toMatchObject({
        status: 400,
        body: { code: 'invalid', field },
      });
    }
    expect(await prisma.promotion.count()).toBe(before);
  });

  it('refuses a code another coupon has (409), in any case', async () => {
    const first = await create(coupon({ name: 'ZZ קופון א', code: 'ZZUNIQUE' }));
    const res = await owner.post('/promotions', coupon({ name: 'ZZ קופון ב', code: 'zzunique' })).expect(409);
    expect(res.body).toMatchObject({ code: 'duplicate', field: 'code', value: 'ZZUNIQUE' });
    const second = await create(coupon({ name: 'ZZ קופון ב', code: 'ZZOTHER' }));
    await owner.put(`/promotions/${second.id}`, coupon({ name: 'ZZ קופון ב', code: 'ZZUNIQUE' })).expect(409);
    // Saving a coupon with its own code is fine.
    await owner.put(`/promotions/${first.id}`, coupon({ name: 'ZZ קופון א', code: 'ZZUNIQUE' })).expect(200);
  });

  it('two creates of the same new code at once: one is saved, the other gets 409', async () => {
    const [a, b] = await Promise.all([
      owner.post('/promotions', coupon({ name: 'ZZ מרוץ א', code: 'ZZRACE' })),
      owner.post('/promotions', coupon({ name: 'ZZ מרוץ ב', code: 'ZZRACE' })),
    ]);
    expect([a.status, b.status].sort((x, y) => x - y)).toEqual([201, 409]);
    expect((a.status === 409 ? a : b).body).toMatchObject({ code: 'duplicate', field: 'code', value: 'ZZRACE' });
    expect(await prisma.promotion.count({ where: { code: 'ZZRACE' } })).toBe(1);
  });

  it('edits a promotion and audits only what changed', async () => {
    const created = await create(coupon({ name: 'ZZ לעריכה', code: 'ZZEDIT' }));
    const saved = (
      await owner
        .put(
          `/promotions/${created.id}`,
          coupon({ name: 'ZZ לעריכה', code: 'ZZEDIT', discountType: 'fixed', value: 25_000, usageLimit: null }),
        )
        .expect(200)
    ).body as AdminPromotion;
    expect(saved).toMatchObject({ id: created.id, discountType: 'fixed', value: 25_000, usageLimit: null });
    const entry = (await audit()).find((e) => e.action === 'promotion.update' && e.entityId === String(created.id));
    expect(entry?.before).toEqual({ הנחה: '10%', 'מגבלת שימוש': '50' });
    expect(entry?.after).toEqual({ הנחה: '₪250', 'מגבלת שימוש': 'ללא הגבלה' });
    await owner.put('/promotions/99999999', coupon({ code: 'ZZNOWHERE' })).expect(404);
  });

  it('deactivates (no delete), audits it, and the coupon stops applying', async () => {
    const created = await create(coupon({ name: 'ZZ להשבתה', code: 'ZZOFF' }));
    const off = (await owner.post(`/promotions/${created.id}/deactivate`).expect(200)).body as AdminPromotion;
    expect(off.active).toBe(false);
    await owner.delete(`/promotions/${created.id}`).expect(404);
    expect(await prisma.promotion.count({ where: { id: created.id } })).toBe(1);
    const entry = (await audit()).find((e) => e.action === 'promotion.deactivate' && e.entityId === String(created.id));
    expect(entry).toMatchObject({ before: { פעיל: 'כן' }, after: { פעיל: 'לא' } });
    await owner.post('/promotions/99999999/deactivate').expect(404);

    const res = await request(app.getHttpServer() as App)
      .post('/api/cart/coupon')
      .set('Origin', STOREFRONT)
      .send({ code: 'zzoff' })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'invalid_coupon', messageHe: 'תוקף הקופון פג' });
  });
  it('the welcome benefit: automatic only; marking one clears it on the others, audited', async () => {
    const bad = await owner.post('/promotions', { ...coupon({ code: 'ZZWELCOME' }), isWelcome: true }).expect(400);
    expect(bad.body).toMatchObject({ code: 'invalid', field: 'isWelcome' });
    await owner.post('/promotions', { ...automatic(), isWelcome: 'yes' }).expect(400);

    const first = await create(automatic({ name: 'ZZ הטבה א', isWelcome: true }));
    expect(first.isWelcome).toBe(true);
    const plain = await create(automatic({ name: 'ZZ רגיל' }));
    expect(plain.isWelcome).toBe(false);
    const second = await create(automatic({ name: 'ZZ הטבה ב', isWelcome: true }));
    expect(second.isWelcome).toBe(true);
    expect((await owner.get(`/promotions/${first.id}`).expect(200)).body).toMatchObject({ isWelcome: false });
    const cleared = (await audit()).find((e) => e.action === 'promotion.update' && e.entityId === String(first.id));
    expect(cleared).toMatchObject({ before: { 'הטבת הצטרפות': 'כן' }, after: { 'הטבת הצטרפות': 'לא' } });

    // Editing marks it back and clears the second.
    await owner.put(`/promotions/${first.id}`, automatic({ name: 'ZZ הטבה א', isWelcome: true })).expect(200);
    const rows = await prisma.promotion.findMany({ where: { isWelcome: true } });
    expect(rows.map((r) => r.id)).toEqual([first.id]);

    // An edit without isWelcome (an older form) keeps the mark; an explicit false removes it.
    const { isWelcome: _omit, ...withoutFlag } = automatic({ name: 'ZZ הטבה א', value: 15 });
    expect(_omit).toBeUndefined();
    const kept = (await owner.put(`/promotions/${first.id}`, withoutFlag).expect(200)).body as AdminPromotion;
    expect(kept).toMatchObject({ value: 15, isWelcome: true });
    const off = (
      await owner.put(`/promotions/${first.id}`, automatic({ name: 'ZZ הטבה א', isWelcome: false })).expect(200)
    ).body as AdminPromotion;
    expect(off.isWelcome).toBe(false);
  });
});
