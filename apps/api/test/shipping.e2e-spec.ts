import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { CartView, ShippingQuote, ShippingQuoteRequest } from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ORIGIN = 'http://localhost:4200';
/** תל אביב - יפו: in no zone. */
const NORMAL_LOCALITY = 5000;
/** שחר: put in the test zone below. */
const ZONE_LOCALITY = 7;
const ZONE_NAME = 'ZZ אזור בדיקה';

// Runs against the e2e test database (migrated and seeded by test/e2e-global-setup.ts). The test brings its own
// top-level categories, rates, settings and zone, so it does not depend on the sample shipping data of the seed.
describe('Shipping quote API (e2e, SHP-01–03, SHP-06, CRT-05)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let big: number;
  let small: number;
  let soonGone: number;
  let savedSettings: { additionalItemPercent: number; floorSurcharge: number; floorSurchargeFrom: number } | null;

  const browser = () => {
    const agent = request.agent(app.getHttpServer());
    return {
      cart: async () => (await agent.get('/api/cart').expect(200)).body as CartView,
      add: (variantId: number, quantity: number) =>
        agent.post('/api/cart/items').set('Origin', ORIGIN).send({ variantId, quantity }).expect(200),
      quote: (body: unknown) =>
        agent
          .post('/api/shipping/quote')
          .set('Origin', ORIGIN)
          .send(body as object),
    };
  };
  const quoteOf = (res: request.Response) => res.body as ShippingQuote;
  const req = (patch: Partial<ShippingQuoteRequest> = {}): ShippingQuoteRequest => ({
    localityId: NORMAL_LOCALITY,
    floor: 4,
    hasElevator: false,
    ...patch,
  });
  const invalidateCatalog = () => app.get(CacheStore).invalidate('catalog:');

  const cleanup = async () => {
    await prisma.cart.deleteMany();
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZSHIP' } } });
    // Sub-categories first: a parent cannot be deleted while it has children.
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-ship' }, parentId: { not: null } } });
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-ship' } } });
    await prisma.shippingZone.deleteMany({ where: { name: ZONE_NAME } });
  };

  /** Two big units and one small unit in the cart, plus a line that becomes unavailable. */
  const filledCart = async () => {
    const b = browser();
    await b.add(big, 2);
    await b.add(small, 1);
    await b.add(soonGone, 1);
    return b;
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await cleanup();

    const size = { widthCm: 200, depthCm: 90, heightCm: 80 };
    const bigCategory = await prisma.category.create({
      data: {
        slug: 'zz-ship-big',
        nameHe: 'בדיקה גדולה',
        shippingRate: { create: { deliveryPrice: 40_000, assemblyPrice: 30_000 } },
      },
    });
    // A sub-category: it uses its top-level category's rate.
    const bigChild = await prisma.category.create({
      data: { slug: 'zz-ship-big-child', nameHe: 'בדיקה גדולה משנית', parentId: bigCategory.id },
    });
    const smallCategory = await prisma.category.create({
      data: {
        slug: 'zz-ship-small',
        nameHe: 'בדיקה קטנה',
        shippingRate: { create: { deliveryPrice: 10_000, assemblyPrice: 0 } },
      },
    });
    const product = async (slug: string, categoryId: number, stock: number) =>
      (
        await prisma.product.create({
          data: {
            slug,
            modelName: slug.toUpperCase().replace(/-/g, ''),
            nameHe: 'מוצר בדיקה',
            categoryId,
            variants: { create: [{ sku: `${slug}-1`, price: 100_000, stock, leadTimeDays: 7, ...size }] },
          },
          include: { variants: true },
        })
      ).variants[0].id;
    big = await product('zzship-big', bigChild.id, 5);
    small = await product('zzship-small', smallCategory.id, 5);
    soonGone = await product('zzship-gone', bigCategory.id, 1);

    savedSettings = await prisma.shippingSettings.findUnique({ where: { id: 1 } });
    const settings = { additionalItemPercent: 50, floorSurcharge: 5_000, floorSurchargeFrom: 2 };
    await prisma.shippingSettings.upsert({ where: { id: 1 }, create: { id: 1, ...settings }, update: settings });
    await prisma.shippingZone.create({
      data: { name: ZONE_NAME, surcharge: 20_000, localities: { create: [{ localityId: ZONE_LOCALITY }] } },
    });
    await invalidateCatalog();
  });

  afterAll(async () => {
    await cleanup();
    if (savedSettings) await prisma.shippingSettings.update({ where: { id: 1 }, data: savedSettings });
    else await prisma.shippingSettings.deleteMany();
    await invalidateCatalog();
    await app.close();
  });

  // 2 × 40,000 + 10,000 delivery; every unit after the most expensive pays 50% → 20,000 + 5,000 off.
  const CURBSIDE = 90_000 - 25_000;
  // + assembly 2 × 30,000, + floor 4 from 2 without an elevator = 3 × 5,000.
  const FULL_SERVICE = CURBSIDE + 60_000 + 15_000;

  it('quotes both methods for a normal locality, leaving out unavailable lines', async () => {
    const b = await filledCart();
    await prisma.variant.update({ where: { id: soonGone }, data: { stock: 0 } });
    try {
      const quote = quoteOf(await b.quote(req()).expect(200));
      expect(quote).toEqual({
        methods: [
          {
            method: 'curbside',
            total: CURBSIDE,
            lines: [
              { labelHe: 'הובלה', amount: 90_000 },
              { labelHe: 'הנחה על פריטים נוספים', amount: -25_000 },
            ],
          },
          {
            method: 'full_service',
            total: FULL_SERVICE,
            lines: [
              { labelHe: 'הובלה', amount: 90_000 },
              { labelHe: 'הנחה על פריטים נוספים', amount: -25_000 },
              { labelHe: 'הרכבה', amount: 60_000 },
              { labelHe: 'תוספת קומה ללא מעלית', amount: 15_000 },
            ],
          },
        ],
      });
    } finally {
      await prisma.variant.update({ where: { id: soonGone }, data: { stock: 1 } });
    }
  });

  it('adds the zone surcharge once to both methods for a locality in a zone', async () => {
    const b = browser();
    await b.add(big, 2);
    await b.add(small, 1);
    const quote = quoteOf(await b.quote(req({ localityId: ZONE_LOCALITY })).expect(200));
    const zoneLine = { labelHe: `תוספת אזור: ${ZONE_NAME}`, amount: 20_000 };
    const [curbside, full] = quote.methods;
    expect(curbside.total).toBe(CURBSIDE + 20_000);
    expect(curbside.lines.at(-1)).toEqual(zoneLine);
    expect(full.total).toBe(FULL_SERVICE + 20_000);
    expect(full.lines.filter((l) => l.labelHe === zoneLine.labelHe)).toEqual([zoneLine]);
  });

  it('adds no floor surcharge with an elevator', async () => {
    const b = browser();
    await b.add(big, 1);
    const quote = quoteOf(await b.quote(req({ hasElevator: true })).expect(200));
    expect(quote.methods[1]).toEqual({
      method: 'full_service',
      total: 70_000,
      lines: [
        { labelHe: 'הובלה', amount: 40_000 },
        { labelHe: 'הרכבה', amount: 30_000 },
      ],
    });
  });

  it('rejects an unknown locality and a bad floor with 400', async () => {
    const b = browser();
    await b.add(big, 1);
    expect((await b.quote(req({ localityId: 99_999_999 })).expect(400)).body.code).toBe('unknown_locality');
    for (const bad of [
      req({ floor: -1 }),
      req({ floor: 61 }),
      req({ floor: 1.5 }),
      { localityId: NORMAL_LOCALITY, floor: 1 },
      { ...req(), localityId: '5000' },
      {},
    ])
      expect((await b.quote(bad).expect(400)).body.code).toBe('invalid_input');
    expect((await b.quote(req({ floor: 60 })).expect(200)).body).toHaveProperty('methods');
  });

  it('answers 409 for an empty cart or one with only unavailable lines', async () => {
    expect((await browser().quote(req()).expect(409)).body.code).toBe('empty_cart');
    const b = browser();
    await b.add(soonGone, 1);
    await prisma.variant.update({ where: { id: soonGone }, data: { stock: 0 } });
    try {
      expect((await b.quote(req()).expect(409)).body.code).toBe('empty_cart');
    } finally {
      await prisma.variant.update({ where: { id: soonGone }, data: { stock: 1 } });
    }
  });

  it('accepts the storefront origin only', async () => {
    await request(app.getHttpServer()).post('/api/shipping/quote').send(req()).expect(403);
    await request(app.getHttpServer())
      .post('/api/shipping/quote')
      .set('Origin', 'http://localhost:4300')
      .send(req())
      .expect(403);
  });

  it('fills the cart shippingFrom: curbside without zone or floor surcharges (CRT-05)', async () => {
    const b = await filledCart();
    // big ×2 + small + the 40,000 line of soonGone: 40k + 3 × 50% of (40k, 40k, 10k).
    expect((await b.cart()).shippingFrom).toBe(130_000 - 45_000);
    await prisma.variant.update({ where: { id: soonGone }, data: { stock: 0 } });
    try {
      expect((await b.cart()).shippingFrom).toBe(CURBSIDE);
    } finally {
      await prisma.variant.update({ where: { id: soonGone }, data: { stock: 1 } });
    }
    expect((await browser().cart()).shippingFrom).toBeNull();
  });

  it('is unavailable (503, shippingFrom null) while there is no default rate row, even with category rates', async () => {
    const b = await filledCart();
    const saved = await prisma.shippingRate.findMany({ where: { categoryId: null } });
    await prisma.shippingRate.deleteMany({ where: { categoryId: null } });
    try {
      expect((await b.quote(req()).expect(503)).body).toMatchObject({ code: 'shipping_unavailable' });
      expect((await b.cart()).shippingFrom).toBeNull();
    } finally {
      await prisma.shippingRate.createMany({ data: saved });
    }
    await b.quote(req()).expect(200);
    expect((await b.cart()).shippingFrom).not.toBeNull();
  });
});
