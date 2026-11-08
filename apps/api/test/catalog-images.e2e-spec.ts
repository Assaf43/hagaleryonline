import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import {
  IMAGE_UPLOAD,
  type AdminImage,
  type AdminProduct,
  type AdminProductInput,
  type AuditPage,
  type OneTimeLink,
  type ProductDetail,
  type ProductListResponse,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, ORIGIN, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/** Product photos end to end (Phase 2d, ADM-04, decision 62). Files go to a temp MEDIA_DIR. */
describe('Catalog images (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let product: AdminProduct;
  const media = process.env.MEDIA_DIR!;
  const base = () => `/catalog/products/${product.id}`;

  const jpeg = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 190, g: 170, b: 140 } } })
      .withExif({ IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1' } })
      .jpeg()
      .toBuffer();
  const upload = (b: AdminBrowser, file: Buffer, fields: Record<string, string> = {}) => {
    let req = b.agent.post(`/api/admin${base()}/images`).set('Origin', ORIGIN).attach('file', file, 'photo.jpg');
    for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
    return req;
  };
  const site = (url: string) => request(app.getHttpServer()).get(url);
  const page = async () => (await site('/api/products/zzphoto-three-seater-sofa').expect(200)).body as ProductDetail;
  const listImage = async () =>
    ((await site('/api/products?q=zzphoto').expect(200)).body as ProductListResponse).items[0].image;
  const files = (image: AdminImage) => image.url.replace('/media/', '').replace(/-\d+\.webp$/, '');

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await prisma.$executeRaw`TRUNCATE admin_users, audit_log RESTART IDENTITY CASCADE`;
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));

    const category = (await prisma.category.findUnique({ where: { slug: 'three-seater-sofas' } }))!;
    const room = (await prisma.room.findFirst())!;
    const variant = (sku: string, color: string) => ({
      sku,
      price: 399_000,
      compareAtPrice: null,
      stock: 2,
      fulfillment: 'in_stock' as const,
      leadTimeDays: 14,
      productionDays: null,
      expectedAt: null,
      active: true,
      widthCm: 220,
      depthCm: 95,
      heightCm: 85,
      weightKg: null,
      seatHeightCm: null,
      seatDepthCm: null,
      chaiseWidthCm: null,
      chaiseDepthCm: null,
      options: { color },
    });
    const input: AdminProductInput = {
      slug: 'zzphoto-three-seater-sofa',
      modelName: 'ZZPHOTO',
      nameHe: 'ספה פוטו',
      descriptionHe: '',
      categoryId: category.id,
      roomIds: [room.id],
      attributes: {},
      countryOfOrigin: null,
      warrantyMonths: null,
      careHe: null,
      requiresAssembly: false,
      active: false,
      sortOrder: 0,
      variants: [variant('ZZPHOTO-BG', 'beige'), variant('ZZPHOTO-GR', 'gray')],
    };
    product = (await editor.post('/catalog/products', input).expect(201)).body as AdminProduct;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({ where: { modelName: { startsWith: 'ZZ' } } });
    await prisma.$executeRaw`TRUNCATE admin_users, audit_log RESTART IDENTITY CASCADE`;
    await app.close();
  });

  const activate = async (active: boolean) => {
    const current = (await editor.get(base()).expect(200)).body as AdminProduct;
    const { id: _id, images: _i, createdAt: _c, updatedAt, ...rest } = current;
    return editor.put(base(), { ...rest, active, expectedUpdatedAt: updatedAt });
  };

  let beigePhoto: AdminImage;
  let generalPhoto: AdminImage;

  it('stores an upload as WebP and AVIF copies without location data, and keeps the original private', async () => {
    const res = await upload(editor, await jpeg(1800, 1200), { colorCode: 'beige', kind: 'lifestyle' }).expect(201);
    beigePhoto = res.body as AdminImage;
    expect(beigePhoto).toMatchObject({
      colorCode: 'beige',
      kind: 'lifestyle',
      altHe: 'ספה פוטו – בז׳',
      width: 1800,
      height: 1200,
    });
    expect(beigePhoto.url).toMatch(/^\/media\/products\/\d+\/[\w-]+-960\.webp$/);
    expect(beigePhoto.thumbUrl).toMatch(/-480\.webp$/);

    const served = await site(beigePhoto.url).buffer(true).expect(200).expect('Content-Type', 'image/webp');
    const meta = await sharp(served.body as Buffer).metadata();
    expect(meta).toMatchObject({ width: 960, height: 640 });
    expect(meta.exif).toBeUndefined();
    await site(beigePhoto.url.replace('.webp', '.avif')).expect(200);

    const key = files(beigePhoto);
    expect(existsSync(join(media, 'private', 'originals', `${key}.jpg`))).toBe(true);
    await site(`/media/originals/${key}.jpg`).expect(404);
    await site(`/media/../private/originals/${key}.jpg`).expect(404);
  });

  it('refuses files that are not usable photos, with the reason', async () => {
    const tooSmall = await upload(editor, await jpeg(500, 400)).expect(400);
    expect(tooSmall.body).toMatchObject({ code: 'invalid', field: 'file', value: 'too_small' });
    const gif = await sharp({ create: { width: 800, height: 600, channels: 3, background: '#ccc' } })
      .gif()
      .toBuffer();
    expect((await upload(editor, gif).expect(400)).body).toMatchObject({ field: 'file', value: 'type' });
    expect((await upload(editor, Buffer.from('hello')).expect(400)).body).toMatchObject({ value: 'unreadable' });
    await upload(editor, Buffer.alloc(IMAGE_UPLOAD.maxBytes + 1)).expect(413);
    expect((await upload(editor, await jpeg(800, 800), { colorCode: 'nope' }).expect(400)).body).toMatchObject({
      field: 'colorCode',
    });
  });

  it('is for users with the photos permission only', async () => {
    const created = await owner
      .post('/users', { email: 'service@example.test', name: 'שירות', template: 'customer_service' })
      .expect(201);
    const service = await acceptAndSignIn(
      app,
      { email: 'service@example.test', password: 'linen chair morning garden' },
      created.body.invite as OneTimeLink,
    );
    await upload(service, await jpeg(800, 800)).expect(403);
  });

  it('shows a product only with a photo; each color gets its own photos', async () => {
    generalPhoto = (await upload(editor, await jpeg(1000, 1000)).expect(201)).body as AdminImage;
    expect(generalPhoto).toMatchObject({ colorCode: null, kind: 'cutout', altHe: 'ספה פוטו' });
    expect((await activate(true)).status).toBe(200);

    const detail = await page();
    expect(detail.images.map((i) => i.url)).toEqual([generalPhoto.url]);
    const [beige, gray] = detail.variants;
    expect(beige.images).toEqual([
      expect.objectContaining({
        url: beigePhoto.url,
        width: 1800,
        srcset: expect.stringContaining('-1600.webp 1600w'),
      }),
    ]);
    expect(beige.images[0].avifSrcset).toMatch(/-480\.avif 480w/);
    expect(gray.images).toEqual([]);
    // The first photo is the main one in lists.
    expect((await listImage())?.url).toBe(beigePhoto.url);
  });

  it('lists the product with the photo of the filtered color', async () => {
    const cardImage = async (query: string) => {
      const res = await site(`/api/products?category=three-seater-sofas&q=zzphoto${query}`).expect(200);
      return (res.body as ProductListResponse).items[0].image?.url;
    };
    const before = await cardImage('');
    expect(before).toBe(beigePhoto.url);

    const grayPhoto = (await upload(editor, await jpeg(900, 900), { colorCode: 'gray' }).expect(201))
      .body as AdminImage;
    try {
      expect(await cardImage('&attr.color=gray')).toBe(grayPhoto.url);
      expect(await cardImage('&attr.color=beige')).toBe(beigePhoto.url);
      expect(await cardImage('&attr.color=gray,beige')).toBe(grayPhoto.url);
      expect(await cardImage('')).toBe(before);
    } finally {
      await editor.delete(`${base()}/images/${grayPhoto.id}`);
    }
  });

  it('reorders, edits and deletes photos, and logs each change on the product', async () => {
    const order = await editor.put(`${base()}/images/order`, { ids: [generalPhoto.id, beigePhoto.id] }).expect(200);
    expect((order.body as AdminImage[]).map((i) => i.id)).toEqual([generalPhoto.id, beigePhoto.id]);
    expect((await listImage())?.url).toBe(generalPhoto.url);
    await editor.put(`${base()}/images/order`, { ids: [generalPhoto.id] }).expect(400);

    const edited = await editor
      .patch(`${base()}/images/${beigePhoto.id}`, { colorCode: 'gray', kind: 'cutout', altHe: 'ספה פוטו באפור' })
      .expect(200);
    expect(edited.body).toMatchObject({ colorCode: 'gray', altHe: 'ספה פוטו באפור' });
    expect((await page()).variants[1].images.map((i) => i.altHe)).toEqual(['ספה פוטו באפור']);

    const key = files(beigePhoto);
    await editor.delete(`${base()}/images/${beigePhoto.id}`).expect(204);
    expect(existsSync(join(media, 'public', `${key}-960.webp`))).toBe(false);
    expect(existsSync(join(media, 'private', 'originals', `${key}.jpg`))).toBe(false);

    // The last photo of a product on the site stays until the product is hidden.
    const last = await editor.delete(`${base()}/images/${generalPhoto.id}`).expect(400);
    expect(last.body).toMatchObject({ code: 'incomplete', reasons: ['no_images'] });

    const audit = (await owner.get(`/audit?entityType=product&entityId=${product.id}`).expect(200)).body as AuditPage;
    expect(audit.items.map((e) => e.action)).toEqual(
      expect.arrayContaining(['image.create', 'image.reorder', 'image.update', 'image.delete']),
    );
    expect(audit.items.find((e) => e.action === 'image.update')).toMatchObject({
      entityLabel: 'ZZPHOTO · ספה פוטו',
      before: { color: 'beige' },
      after: { color: 'gray' },
    });
  });

  it('a color used by a photo cannot be deleted, and deleting the product removes its files', async () => {
    await editor.patch(`${base()}/images/${generalPhoto.id}`, { colorCode: 'beige', kind: 'cutout', altHe: 'x' });
    const beige = (await prisma.attributeValue.findFirst({ where: { code: 'beige', attribute: { code: 'color' } } }))!;
    expect(
      (await owner.delete(`/catalog/attributes/${beige.attributeId}/values/${beige.id}`).expect(409)).body,
    ).toMatchObject({
      code: 'in_use',
    });

    const key = files(generalPhoto);
    await owner.delete(base()).expect(204);
    expect(existsSync(join(media, 'public', `${key}-480.webp`))).toBe(false);
  });
});
