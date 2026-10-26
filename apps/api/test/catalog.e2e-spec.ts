import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { ProductDetail, ProductListResponse, RoomMenuItem, SearchSuggestions } from '@hg/models';
import { AppModule } from './../src/app.module.js';

// Runs against the seeded database: `npm run db:up`, `npm run prisma:deploy -w @hg/api`, `npm run db:seed -w @hg/api`.
describe('Catalog API (e2e)', () => {
  let app: INestApplication<App>;
  const get = (url: string) => request(app.getHttpServer()).get(url);
  const list = async (query: string) => (await get(`/api/products?${query}`).expect(200)).body as ProductListResponse;
  const search = async (q: string) =>
    (await list(`q=${encodeURIComponent(q)}&pageSize=60`)).items.map((i) => i.modelName);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
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
    expect(product.breadcrumbs.map((b) => b.slug)).toEqual(['sofas', 'corner-sofas']);
    expect(product.optionAxes.map((a) => a.code)).toEqual(['color', 'fabric', 'chaise-side']);
    expect(product.variants).toHaveLength(3 * 4 * 2 * 2);
    const variant = product.variants.find((v) => v.sku === 'ALBA-300-BG-WV-R')!;
    expect(variant.options).toEqual({ color: 'beige', fabric: 'woven', 'chaise-side': 'right' });
    expect(variant.dimensions).toMatchObject({ widthCm: 300, depthCm: 95, seatDepthCm: 58, chaiseDepthCm: 165 });
    expect(product.specs.find((s) => s.code === 'style')?.valuesHe).toEqual(
      expect.arrayContaining(['מודרני', 'נורדי']),
    );
  });

  it('returns 404 for an unknown product', async () => {
    await get('/api/products/no-such-sofa').expect(404);
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
});
