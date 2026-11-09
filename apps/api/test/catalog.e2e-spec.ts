import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type {
  ProductCard,
  ProductDetail,
  ProductListResponse,
  RelatedProducts,
  RoomMenuItem,
  SearchSuggestions,
  SitemapData,
} from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

// Runs against the e2e test database, migrated and seeded by test/e2e-global-setup.ts (needs `npm run db:up`).
describe('Catalog API (e2e)', () => {
  let app: INestApplication<App>;
  const get = (url: string) => request(app.getHttpServer()).get(url);
  const list = async (query: string) => (await get(`/api/products?${query}`).expect(200)).body as ProductListResponse;
  const search = async (q: string) =>
    (await list(`q=${encodeURIComponent(q)}&pageSize=60`)).items.map((i) => i.modelName);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /api/rooms lists the living room with its furniture types (decision 44)', async () => {
    const rooms = (await get('/api/rooms').expect(200)).body as RoomMenuItem[];
    expect(rooms.map((r) => r.slug)).toEqual(['living-room']);
    expect(rooms[0].categories.slice(0, 3).map((c) => c.nameHe)).toEqual(['ספות', 'כורסאות', 'כורסאות טלוויזיה']);
  });

  it('GET /api/categories nests sofa types under sofas', async () => {
    const tree = (await get('/api/categories').expect(200)).body;
    const sofas = tree.find((c: { slug: string }) => c.slug === 'sofas');
    expect(sofas.children.map((c: { slug: string }) => c.slug)).toContain('corner-sofas');
  });

  it('filters sofas by width and price, every result inside the bounds (CAT-04)', async () => {
    const result = await list('category=sofas&minWidth=220&maxWidth=300&maxPrice=600000&sort=price_asc');
    expect(result.items.map((i) => i.modelName)).toEqual(['SHAKED', 'NORA', 'ROMA', 'ALBA']);
    expect(result.items.every((i) => i.priceFrom <= 600_000)).toBe(true);
    expect(result.ranges.width).toEqual({ min: 165, max: 340 });
    expect(result.facets.map((f) => f.code)).toEqual([
      'color',
      'fabric',
      'chaise-side',
      'softness',
      'features',
      'style',
    ]);
  });

  it('combines attribute filters per variant', async () => {
    const result = await list('category=corner-sofas&attr.color=olive&attr.chaise-side=left');
    expect(result.items.map((i) => i.modelName)).toEqual(['ALBA']);
  });

  it('rejects malformed filters with 400', async () => {
    await get('/api/products?minWidth=wide').expect(400);
    await get('/api/products?sort=random').expect(400);
  });

  it('GET /api/products/:slug returns variants, option axes and dimensions', async () => {
    const product = (await get('/api/products/alba-corner-sofa').expect(200)).body as ProductDetail;
    expect(product.modelName).toBe('ALBA');
    // The id is what the favorites store keeps (CMP-01).
    expect(Number.isInteger(product.id) && product.id > 0).toBe(true);
    expect(product.breadcrumbs.map((b) => b.slug)).toEqual(['sofas', 'corner-sofas']);
    expect(product.optionAxes.map((a) => a.code)).toEqual(['color', 'fabric', 'size', 'chaise-side']);
    expect(product.variants).toHaveLength(3 * 4 * 2 * 2);
    const variant = product.variants.find((v) => v.sku === 'ALBA-300-BG-WV-R')!;
    expect(variant.options).toEqual({ color: 'beige', fabric: 'woven', size: '300', 'chaise-side': 'right' });
    expect(variant.dimensions).toMatchObject({ widthCm: 300, depthCm: 95, seatDepthCm: 58, chaiseDepthCm: 165 });
    expect(product.specs.find((s) => s.code === 'style')?.valuesHe).toEqual(
      expect.arrayContaining(['מודרני', 'נורדי']),
    );
  });

  it('GET /api/products/:slug derives a size axis from the variant dimensions (PRD-04)', async () => {
    const product = (await get('/api/products/alba-corner-sofa').expect(200)).body as ProductDetail;
    const size = product.optionAxes.find((a) => a.code === 'size')!;
    expect(size.nameHe).toBe('מידה');
    expect(size.values).toEqual([
      { code: '260', labelHe: '260 ס״מ', hex: null },
      { code: '300', labelHe: '300 ס״מ', hex: null },
      { code: '340', labelHe: '340 ס״מ', hex: null },
    ]);
    for (const v of product.variants) expect(String(v.dimensions.widthCm)).toBe(v.options['size']);
  });

  it('every variant of every product has a unique option set', async () => {
    const { items } = await list('pageSize=60');
    expect(items.length).toBeGreaterThan(20);
    for (const { slug } of items) {
      const product = (await get(`/api/products/${slug}`).expect(200)).body as ProductDetail;
      const axes = product.optionAxes.map((a) => a.code);
      const keys = product.variants.map((v) => {
        expect(Object.keys(v.options).sort()).toEqual([...axes].sort());
        return axes.map((code) => v.options[code]).join('|');
      });
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('has no size axis when every variant has the same size', async () => {
    const product = (await get('/api/products/nora-three-seater-sofa').expect(200)).body as ProductDetail;
    expect(new Set(product.variants.map((v) => v.dimensions.widthCm)).size).toBe(1);
    expect(product.optionAxes.map((a) => a.code)).not.toContain('size');
    expect(product.variants.every((v) => !('size' in v.options))).toBe(true);
  });

  it('returns 404 for an unknown product', async () => {
    await get('/api/products/no-such-sofa').expect(404);
  });

  describe('related products (PRD-12) and cards by id (CMP-01)', () => {
    let prisma: PrismaService;
    let hiddenId: number;
    const idOf = async (slug: string) => (await prisma.product.findUniqueOrThrow({ where: { slug } })).id;
    const related = async (slug: string) =>
      (await get(`/api/products/${slug}/related`).expect(200)).body as RelatedProducts;

    beforeAll(async () => {
      prisma = app.get(PrismaService);
      await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZ' } } });
      const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'corner-sofas' } });
      const hidden = await prisma.product.create({
        data: {
          slug: 'zz-hidden-sofa',
          modelName: 'ZZHIDDEN',
          nameHe: 'ספה מוסתרת',
          categoryId: sofas.id,
          active: false,
          variants: {
            create: { sku: 'ZZHIDDEN-1', price: 400_000, leadTimeDays: 14, widthCm: 280, depthCm: 95, heightCm: 85 },
          },
        },
      });
      hiddenId = hidden.id;
    });

    afterAll(async () => {
      await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZ' } } });
      await prisma.productRelation.deleteMany({ where: { productId: await idOf('alba-corner-sofa') } });
      await app.get(CacheStore).invalidate('catalog:');
    });

    it('GET /api/products/:slug/related returns both rows, at most 8 cards, never the product itself', async () => {
      const { goesWith, similar } = await related('alba-corner-sofa');
      for (const row of [goesWith, similar]) {
        expect(row.length).toBeGreaterThan(0);
        expect(row.length).toBeLessThanOrEqual(8);
        expect(row.map((c) => c.modelName)).not.toContain('ALBA');
        expect(new Set(row.map((c) => c.id)).size).toBe(row.length);
      }
      // Similar: the other corner sofa first (same leaf), topped up with other sofas.
      expect(similar[0].modelName).toBe('TAVOR');
      // Goes with: no sofas, one per furniture type in menu order — armchairs come first.
      const sofaSlugs = (await list('category=sofas&pageSize=60')).items.map((i) => i.slug);
      expect(goesWith.some((c) => sofaSlugs.includes(c.slug))).toBe(false);
      expect(goesWith[0].slug).toMatch(/armchair/);
    });

    it('puts visible manual picks first and skips hidden ones (decision 67)', async () => {
      const alba = await idOf('alba-corner-sofa');
      const luna = await idOf('luna-armchair');
      const gal = await idOf('gal-side-table');
      await prisma.productRelation.createMany({
        data: [
          { productId: alba, relatedId: hiddenId, kind: 'goes_with', position: 0 },
          { productId: alba, relatedId: gal, kind: 'goes_with', position: 1 },
          { productId: alba, relatedId: luna, kind: 'goes_with', position: 2 },
        ],
      });
      await app.get(CacheStore).invalidate('catalog:');

      const { goesWith } = await related('alba-corner-sofa');
      expect(goesWith.slice(0, 2).map((c) => c.slug)).toEqual(['gal-side-table', 'luna-armchair']);
      expect(goesWith.map((c) => c.id)).not.toContain(hiddenId);
      expect(goesWith.filter((c) => c.slug === 'luna-armchair')).toHaveLength(1);
    });

    it('returns 404 for an unknown or hidden product', async () => {
      await get('/api/products/no-such-sofa/related').expect(404);
      await get('/api/products/zz-hidden-sofa/related').expect(404);
    });

    it('GET /api/products/cards returns cards in the requested order, first occurrence only', async () => {
      const a = await idOf('alba-corner-sofa');
      const b = await idOf('luna-armchair');
      const cards = (await get(`/api/products/cards?ids=${b},${a},x,${a}`).expect(200)).body as ProductCard[];
      expect(cards.map((c) => [c.id, c.slug])).toEqual([
        [b, 'luna-armchair'],
        [a, 'alba-corner-sofa'],
      ]);
      expect(cards[1]).toMatchObject({ modelName: 'ALBA', priceFrom: expect.any(Number) });
    });

    it('GET /api/products/cards leaves out hidden products and takes no ids as empty', async () => {
      const a = await idOf('alba-corner-sofa');
      const cards = (await get(`/api/products/cards?ids=${hiddenId},${a}`).expect(200)).body as ProductCard[];
      expect(cards.map((c) => c.id)).toEqual([a]);
      expect((await get('/api/products/cards').expect(200)).body).toEqual([]);
      expect((await get('/api/products/cards?ids=').expect(200)).body).toEqual([]);
    });

    it('GET /api/products/cards rejects more than 100 ids', async () => {
      const ids = Array.from({ length: 101 }, (_, i) => i + 1).join(',');
      await get(`/api/products/cards?ids=${ids}`).expect(400);
    });
  });

  describe('search (decision 47)', () => {
    it('finds the English model name and SKUs', async () => {
      expect(await search('alba')).toEqual(['ALBA']);
      expect(await search('ALBA-300-BG')).toEqual(['ALBA']);
    });

    it('tolerates typos, Hebrew prefixes, geresh and synonyms', async () => {
      expect(await search('ספה פינטית')).toEqual(['ALBA', 'TAVOR']);
      expect(await search('הספה')).toEqual(expect.arrayContaining(['ALBA', 'NORA', 'GILBOA']));
      expect(await search("שז'לונג")).toEqual(expect.arrayContaining(['ROMA']));
      expect(await search('כורסא')).toEqual(['LUNA', 'ORI', 'HERMON']);
      expect(await search('lamp')).toEqual(expect.arrayContaining(['SHIR', 'OFEK']));
    });

    it('splits hyphenated words like תלת-מושבית', async () => {
      expect(await search('תלת מושבית')).toEqual(expect.arrayContaining(['NORA', 'SHAKED']));
    });

    it('finds nothing for gibberish', async () => {
      expect(await search('xyzqq')).toEqual([]);
    });

    it('GET /api/search/suggest returns products and categories', async () => {
      const suggestions = (await get(`/api/search/suggest?q=${encodeURIComponent('שטיח')}`).expect(200))
        .body as SearchSuggestions;
      expect(suggestions.products.map((p) => p.modelName)).toEqual(expect.arrayContaining(['DUNE', 'KESHET']));
      expect(suggestions.categories).toEqual([{ slug: 'rugs', nameHe: 'שטיחים' }]);
    });
  });

  describe('sitemap data (NFR-06)', () => {
    let prisma: PrismaService;
    const sitemap = async () => (await get('/api/seo/sitemap').expect(200)).body as SitemapData;

    beforeAll(async () => {
      prisma = app.get(PrismaService);
      await prisma.category.deleteMany({ where: { slug: 'zz-empty-category' } });
      await prisma.room.deleteMany({ where: { slug: 'zz-empty-room' } });
      await prisma.category.create({ data: { slug: 'zz-empty-category', nameHe: 'ריקה' } });
      await prisma.room.create({ data: { slug: 'zz-empty-room', nameHe: 'חדר ריק' } });
      await app.get(CacheStore).invalidate('catalog:');
    });

    afterAll(async () => {
      await prisma.product.update({ where: { slug: 'luna-armchair' }, data: { active: true } });
      await prisma.category.deleteMany({ where: { slug: 'zz-empty-category' } });
      await prisma.room.deleteMany({ where: { slug: 'zz-empty-room' } });
      await app.get(CacheStore).invalidate('catalog:');
    });

    it('sitemap lists visible products only and skips empty categories', async () => {
      const before = await sitemap();
      const luna = before.products.find((p) => p.slug === 'luna-armchair');
      expect(luna?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(before.products.map((p) => p.slug)).toContain('alba-corner-sofa');
      // A parent is listed through its sub-categories' products.
      expect(before.categories.map((c) => c.slug)).toEqual(expect.arrayContaining(['sofas', 'corner-sofas', 'rugs']));
      expect(before.categories.map((c) => c.slug)).not.toContain('zz-empty-category');
      expect(before.rooms).toEqual([{ slug: 'living-room' }]);

      await prisma.product.update({ where: { slug: 'luna-armchair' }, data: { active: false } });
      await app.get(CacheStore).invalidate('catalog:');
      const after = await sitemap();
      expect(after.products.map((p) => p.slug)).not.toContain('luna-armchair');
      expect(after.products).toHaveLength(before.products.length - 1);
    });
  });
});
