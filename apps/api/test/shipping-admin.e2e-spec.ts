import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AdminShippingConfig, AdminShippingRatesInput, AdminShippingZone, AuditPage } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/** שחר and תירוש: CBS codes of the localities seed. */
const SHAHAR = 7;
const TIROSH = 10;
const ZONE_A = 'ZZ אזור א';
const ZONE_B = 'ZZ אזור ב';

// The e2e database is seeded with the sample price list; this file saves it back at the end.
describe('Shipping admin (e2e, ADM-07)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let saved: AdminShippingConfig;
  let topCategory: number;
  let subCategory: number;

  const cleanup = async () => {
    await prisma.shippingZone.deleteMany({ where: { name: { startsWith: 'ZZ' } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-shipadmin' }, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-shipadmin' } } });
  };
  const config = async (b: AdminBrowser = owner) => (await b.get('/shipping').expect(200)).body as AdminShippingConfig;
  const ratesInput = (c: AdminShippingConfig): AdminShippingRatesInput => ({
    rates: c.rates.map(({ categoryId, deliveryPrice, assemblyPrice }) => ({
      categoryId,
      deliveryPrice,
      assemblyPrice,
    })),
    settings: c.settings,
  });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    const top = await prisma.category.create({ data: { slug: 'zz-shipadmin-top', nameHe: 'בדיקת משלוח' } });
    const sub = await prisma.category.create({
      data: { slug: 'zz-shipadmin-sub', nameHe: 'בדיקת משלוח משנית', parentId: top.id },
    });
    topCategory = top.id;
    subCategory = sub.id;
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    saved = await config();
  });

  afterAll(async () => {
    await owner.put('/shipping/rates', ratesInput(saved)).expect(200);
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('needs the shipping permission', async () => {
    await editor.get('/shipping').expect(403);
    await editor.put('/shipping/rates', ratesInput(saved)).expect(403);
    await editor.post('/shipping/zones', { name: ZONE_A, surcharge: 0, localityIds: [] }).expect(403);
  });

  it('lists the default row first, then every top-level category but no sub-category', async () => {
    const c = await config();
    expect(c.rates[0]).toMatchObject({ categoryId: null });
    const ids = c.rates.map((r) => r.categoryId);
    expect(ids).toContain(topCategory);
    expect(ids).not.toContain(subCategory);
    expect(c.rates.find((r) => r.categoryId === topCategory)).toEqual({
      categoryId: topCategory,
      categoryNameHe: 'בדיקת משלוח',
      deliveryPrice: null,
      assemblyPrice: null,
    });
  });

  it('saves the rates and the settings together, and audits the change', async () => {
    const input = ratesInput(await config());
    input.rates = input.rates.map((r) =>
      r.categoryId === null
        ? { ...r, deliveryPrice: 12_300, assemblyPrice: 4_500 }
        : r.categoryId === topCategory
          ? { ...r, deliveryPrice: 50_000, assemblyPrice: 25_000 }
          : r,
    );
    input.settings = { additionalItemPercent: 40, floorSurcharge: 6_000, floorSurchargeFrom: 3 };
    const res = (await owner.put('/shipping/rates', input).expect(200)).body as AdminShippingConfig;
    expect(res.settings).toEqual(input.settings);
    expect(res.rates[0]).toMatchObject({ categoryId: null, deliveryPrice: 12_300, assemblyPrice: 4_500 });
    expect(res.rates.find((r) => r.categoryId === topCategory)).toMatchObject({
      deliveryPrice: 50_000,
      assemblyPrice: 25_000,
    });
    expect(await config()).toEqual(res);
    // Still exactly one default row.
    expect(await prisma.shippingRate.count({ where: { categoryId: null } })).toBe(1);

    const audit = (await owner.get('/audit?entityType=shipping').expect(200)).body as AuditPage;
    expect(audit.items[0]).toMatchObject({ action: 'shipping.rates.update' });

    // Emptying a category's prices removes its rate: it uses the default row again.
    input.rates = input.rates.map((r) =>
      r.categoryId === topCategory ? { ...r, deliveryPrice: null, assemblyPrice: null } : r,
    );
    await owner.put('/shipping/rates', input).expect(200);
    expect(await prisma.shippingRate.findUnique({ where: { categoryId: topCategory } })).toBeNull();
  });

  it('refuses invalid values and rates for sub-categories', async () => {
    const input = ratesInput(await config());
    await owner
      .put('/shipping/rates', { ...input, settings: { ...input.settings, additionalItemPercent: 101 } })
      .expect(400);
    await owner
      .put('/shipping/rates', { ...input, settings: { ...input.settings, floorSurchargeFrom: 0 } })
      .expect(400);
    const negative = input.rates.map((r) => (r.categoryId === null ? { ...r, deliveryPrice: -1 } : r));
    await owner.put('/shipping/rates', { ...input, rates: negative }).expect(400);
    const sub = [...input.rates, { categoryId: subCategory, deliveryPrice: 1_000, assemblyPrice: 0 }];
    const res = await owner.put('/shipping/rates', { ...input, rates: sub }).expect(400);
    expect(res.body).toMatchObject({ code: 'invalid', field: `rates.${sub.length - 1}.categoryId` });
  });

  it('creates, edits and deletes zones; a locality is in one zone only', async () => {
    const a = (
      await owner.post('/shipping/zones', { name: ZONE_A, surcharge: 20_000, localityIds: [SHAHAR] }).expect(201)
    ).body as AdminShippingZone;
    expect(a).toMatchObject({ name: ZONE_A, surcharge: 20_000, localities: [{ id: SHAHAR, nameHe: 'שחר' }] });

    const taken = await owner
      .post('/shipping/zones', { name: ZONE_B, surcharge: 0, localityIds: [TIROSH, SHAHAR] })
      .expect(409);
    expect(taken.body).toMatchObject({ code: 'locality_taken', zoneName: ZONE_A, localityNameHe: 'שחר' });
    expect(await prisma.shippingZone.count({ where: { name: ZONE_B } })).toBe(0);

    const b = (await owner.post('/shipping/zones', { name: ZONE_B, surcharge: 0, localityIds: [TIROSH] }).expect(201))
      .body as AdminShippingZone;
    await owner
      .put(`/shipping/zones/${b.id}`, { name: ZONE_B, surcharge: 0, localityIds: [TIROSH, SHAHAR] })
      .expect(409);

    // Moving a locality: remove it from A first, then add it to B.
    const editedA = (
      await owner
        .put(`/shipping/zones/${a.id}`, { name: `${ZONE_A} מעודכן`, surcharge: 21_000, localityIds: [] })
        .expect(200)
    ).body as AdminShippingZone;
    expect(editedA).toMatchObject({ name: `${ZONE_A} מעודכן`, surcharge: 21_000, localities: [] });
    const editedB = (
      await owner
        .put(`/shipping/zones/${b.id}`, { name: ZONE_B, surcharge: 0, localityIds: [TIROSH, SHAHAR] })
        .expect(200)
    ).body as AdminShippingZone;
    expect(editedB.localities.map((l) => l.id).sort((x, y) => x - y)).toEqual([SHAHAR, TIROSH]);

    await owner.post('/shipping/zones', { name: ZONE_A, surcharge: 0, localityIds: [99_999_999] }).expect(400);
    await owner.delete(`/shipping/zones/${a.id}`).expect(204);
    await owner.delete(`/shipping/zones/${a.id}`).expect(404);
    expect((await config()).zones.map((z) => z.id)).toContain(b.id);
    expect((await config()).zones.map((z) => z.id)).not.toContain(a.id);

    const audit = (await owner.get('/audit?entityType=shipping_zone').expect(200)).body as AuditPage;
    expect(audit.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(['shipping_zone.create', 'shipping_zone.update', 'shipping_zone.delete']),
    );
    expect(audit.items.find((e) => e.action === 'shipping_zone.delete')).toMatchObject({ entityId: String(a.id) });
  });
});
