import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import {
  CONTENT_IMAGE,
  type AdminBanner,
  type AdminBannerInput,
  type AdminContentImage,
  type AuditPage,
  type OneTimeLink,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, ORIGIN, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/**
 * Content images and banners (Phase 8 §4.5, §6, NAV-05, ADM-06). Photos go to the temp MEDIA_DIR; every banner this
 * file creates is named "ZZ…", and every content image row and file it creates is removed in afterAll (the e2e
 * database persists between runs).
 */
describe('Content images and banners (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let service: AdminBrowser;
  const media = process.env.MEDIA_DIR!;
  const createdImages: number[] = [];

  const jpeg = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 190, g: 170, b: 140 } } })
      .withExif({ IFD0: { Make: 'Phone' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '32/1 4/1 0/1' } })
      .jpeg()
      .toBuffer();
  const upload = (b: AdminBrowser, file: Buffer, name = 'photo.jpg') =>
    b.agent.post('/api/admin/content/images').set('Origin', ORIGIN).attach('file', file, name);
  const uploaded = async (width: number, height: number) => {
    const res = await upload(editor, await jpeg(width, height)).expect(201);
    const body = res.body as AdminContentImage;
    createdImages.push(body.id);
    return body;
  };
  const site = (url: string) => request(app.getHttpServer()).get(url);
  /** `content/<random>` from a public URL such as `/media/content/abc-960.webp`. */
  const keyOf = (url: string) => url.replace('/media/', '').replace(/-\d+\.webp$/, '');
  const audit = async (entityType: string) =>
    ((await owner.get(`/audit?entityType=${entityType}`).expect(200)).body as AuditPage).items;

  let desktop: AdminContentImage;
  let mobile: AdminContentImage;
  const input = (over: Partial<AdminBannerInput> = {}): AdminBannerInput => ({
    nameHe: 'ZZ מבצע סלון',
    headlineHe: 'ספות חדשות לסלון',
    sublineHe: 'בדים חדשים לחורף',
    ctaLabelHe: 'לכל הספות',
    linkUrl: '/category/sofas',
    imageId: desktop.id,
    mobileImageId: mobile.id,
    altHe: 'ספה אפורה בסלון מואר',
    active: true,
    startsAt: null,
    endsAt: null,
    ...over,
  });
  const bodyOf = (b: AdminBanner, over: Partial<AdminBannerInput> = {}) => ({
    nameHe: b.nameHe,
    headlineHe: b.headlineHe,
    sublineHe: b.sublineHe,
    ctaLabelHe: b.ctaLabelHe,
    linkUrl: b.linkUrl,
    imageId: b.imageId,
    mobileImageId: b.mobileImageId,
    altHe: b.altHe,
    active: b.active,
    startsAt: b.startsAt,
    endsAt: b.endsAt,
    expectedUpdatedAt: b.updatedAt,
    ...over,
  });

  const cleanup = async () => {
    await prisma.banner.deleteMany({ where: { nameHe: { startsWith: 'ZZ' } } });
    const rows = await prisma.contentImage.findMany({ where: { id: { in: createdImages } } });
    await prisma.contentImage.deleteMany({ where: { id: { in: createdImages } } });
    for (const row of rows) {
      for (const w of row.widths)
        for (const f of ['webp', 'avif'])
          await rm(join(media, 'public', `${row.storageKey}-${w}.${f}`), { force: true });
      await rm(join(media, 'private', 'originals', `${row.storageKey}.${row.originalExt}`), { force: true });
    }
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await prisma.banner.deleteMany({ where: { nameHe: { startsWith: 'ZZ' } } });
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    const created = await owner
      .post('/users', { email: 'service@example.test', name: 'שירות', template: 'customer_service' })
      .expect(201);
    service = await acceptAndSignIn(
      app,
      { email: 'service@example.test', password: 'velvet chair morning tide' },
      created.body.invite as OneTimeLink,
    );
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  it('needs content.manage: 403 for a user without it', async () => {
    await upload(service, await jpeg(1400, 1000)).expect(403);
    await service.get('/content/banners').expect(403);
    await service.get('/content/banners/1').expect(403);
    await service.post('/content/banners', {}).expect(403);
    await service.put('/content/banners/1', {}).expect(403);
    await service.delete('/content/banners/1').expect(403);
  });

  it('stores an upload in four widths as WebP and AVIF without location data, the original kept privately', async () => {
    desktop = await uploaded(3000, 1500);
    expect(desktop.image.url).toMatch(/^\/media\/content\/[\w-]+-960\.webp$/);
    expect(desktop.image).toMatchObject({ altHe: '', width: 3000, height: 1500 });
    expect(desktop.image.srcset).toContain('-2400.webp 2400w');
    expect(desktop.image.avifSrcset).toContain('-2400.avif 2400w');

    const row = await prisma.contentImage.findUniqueOrThrow({ where: { id: desktop.id } });
    expect(row).toMatchObject({ widths: [...CONTENT_IMAGE.widths], width: 3000, height: 1500, originalExt: 'jpg' });
    const key = keyOf(desktop.image.url);
    expect(row.storageKey).toBe(key);
    for (const w of CONTENT_IMAGE.widths)
      for (const f of ['webp', 'avif']) expect(existsSync(join(media, 'public', `${key}-${w}.${f}`))).toBe(true);
    expect(existsSync(join(media, 'private', 'originals', `${key}.jpg`))).toBe(true);

    const served = await site(`/media/${key}-2400.webp`).buffer(true).expect(200).expect('Content-Type', 'image/webp');
    const meta = await sharp(served.body as Buffer).metadata();
    expect(meta).toMatchObject({ width: 2400, height: 1200 });
    expect(meta.exif).toBeUndefined();
    await site(`/media/originals/${key}.jpg`).expect(404);

    // A portrait photo narrower than 2400 gets its own width instead (never upscaled).
    mobile = await uploaded(1000, 1400);
    expect((await prisma.contentImage.findUniqueOrThrow({ where: { id: mobile.id } })).widths).toEqual([
      480, 960, 1000,
    ]);

    const [entry] = await audit('content_image');
    expect(entry).toMatchObject({ action: 'content.image.create', entityId: String(mobile.id) });
    expect(entry.after).toEqual({ מידות: '1000×1400', סוג: 'jpg' });
  });

  it('refuses files that are not usable content photos, with the reason', async () => {
    const before = await prisma.contentImage.count();
    // 1100 px is fine for a product photo, too small for a banner.
    expect((await upload(editor, await jpeg(1100, 800)).expect(400)).body).toMatchObject({
      code: 'invalid',
      field: 'file',
      value: 'too_small',
    });
    const gif = await sharp({ create: { width: 1400, height: 1000, channels: 3, background: '#ccc' } })
      .gif()
      .toBuffer();
    expect((await upload(editor, gif, 'a.gif').expect(400)).body).toMatchObject({ field: 'file', value: 'type' });
    expect((await upload(editor, Buffer.from('hello'), 'a.txt').expect(400)).body).toMatchObject({
      value: 'unreadable',
    });
    expect((await editor.agent.post('/api/admin/content/images').set('Origin', ORIGIN).expect(400)).body).toMatchObject(
      { field: 'file', value: 'unreadable' },
    );
    await upload(editor, Buffer.alloc(CONTENT_IMAGE.maxBytes + 1)).expect(413);
    // Nothing was stored for the refused uploads.
    expect(await prisma.contentImage.count()).toBe(before);
  });

  let banner: AdminBanner;

  it('creates a banner with a desktop and a mobile photo', async () => {
    banner = (await editor.post('/content/banners', input()).expect(201)).body as AdminBanner;
    expect(banner).toMatchObject({
      nameHe: 'ZZ מבצע סלון',
      headlineHe: 'ספות חדשות לסלון',
      sublineHe: 'בדים חדשים לחורף',
      ctaLabelHe: 'לכל הספות',
      linkUrl: '/category/sofas',
      imageId: desktop.id,
      mobileImageId: mobile.id,
      altHe: 'ספה אפורה בסלון מואר',
      active: true,
      startsAt: null,
      endsAt: null,
    });
    expect(banner.image).toMatchObject({ url: desktop.image.url, altHe: 'ספה אפורה בסלון מואר', width: 3000 });
    expect(banner.mobileImage).toMatchObject({ url: mobile.image.url, altHe: 'ספה אפורה בסלון מואר' });

    const list = (await editor.get('/content/banners').expect(200)).body as AdminBanner[];
    expect(list.map((b) => b.id)).toContain(banner.id);
    expect((await editor.get(`/content/banners/${banner.id}`).expect(200)).body).toEqual(banner);
    await editor.get('/content/banners/999999').expect(404);

    // Optional texts and the mobile photo may be left out.
    const plain = (
      await editor
        .post('/content/banners', input({ nameHe: 'ZZ פשוט', sublineHe: '  ', ctaLabelHe: null, mobileImageId: null }))
        .expect(201)
    ).body as AdminBanner;
    expect(plain).toMatchObject({ sublineHe: null, ctaLabelHe: null, mobileImageId: null, mobileImage: null });
    await editor.delete(`/content/banners/${plain.id}`).expect(204);
  });

  it('refuses unsafe or missing links with invalid_link, and other bad fields with invalid', async () => {
    for (const linkUrl of ['javascript:alert(1)', '//evil.example/x', 'http://plain.example', 'data:text/html,x', ''])
      expect((await editor.post('/content/banners', input({ linkUrl })).expect(400)).body).toMatchObject({
        code: 'invalid_link',
        field: 'linkUrl',
      });
    const { linkUrl: _l, ...noLink } = input();
    expect((await editor.post('/content/banners', noLink).expect(400)).body).toMatchObject({ code: 'invalid_link' });
    await editor
      .post('/content/banners', input({ nameHe: 'ZZ קישור חיצוני', linkUrl: 'https://example.com/a' }))
      .expect(201);

    const bad = async (over: Partial<AdminBannerInput> | Record<string, unknown>, field: string) =>
      expect((await editor.post('/content/banners', { ...input(), ...over }).expect(400)).body).toMatchObject({
        code: 'invalid',
        field,
      });
    await bad({ headlineHe: ' ' }, 'headlineHe');
    await bad({ nameHe: 'x'.repeat(81) }, 'nameHe');
    await bad({ altHe: '' }, 'altHe');
    await bad({ imageId: 999999 }, 'imageId');
    await bad({ imageId: null }, 'imageId');
    await bad({ mobileImageId: 999999 }, 'mobileImageId');
    await bad({ active: 'yes' }, 'active');
    await bad({ startsAt: '2026-12-31T22:00:00.000Z', endsAt: '2026-12-01T21:59:59.999Z' }, 'endsAt');
  });

  it('updates with expectedUpdatedAt; a stale save is a 409 conflict', async () => {
    const endsAt = '2026-12-31T21:59:59.999Z';
    const updated = (
      await editor
        .put(`/content/banners/${banner.id}`, bodyOf(banner, { headlineHe: 'ספות לחורף', mobileImageId: null, endsAt }))
        .expect(200)
    ).body as AdminBanner;
    expect(updated).toMatchObject({ headlineHe: 'ספות לחורף', mobileImageId: null, mobileImage: null, endsAt });

    // The editor still holds the old `updatedAt`.
    expect(
      (await editor.put(`/content/banners/${banner.id}`, bodyOf(banner, { headlineHe: 'ישן' })).expect(409)).body,
    ).toMatchObject({ code: 'conflict' });
    const { expectedUpdatedAt: _e, ...noStamp } = bodyOf(updated);
    expect((await editor.put(`/content/banners/${banner.id}`, noStamp).expect(400)).body).toMatchObject({
      field: 'expectedUpdatedAt',
    });
    await editor.put('/content/banners/999999', bodyOf(updated)).expect(404);
    banner = updated;
  });

  it('a photo in use cannot be deleted (Restrict); deleting the banner keeps its photos', async () => {
    await expect(prisma.contentImage.delete({ where: { id: desktop.id } })).rejects.toThrow();
    await editor.delete(`/content/banners/${banner.id}`).expect(204);
    await editor.get(`/content/banners/${banner.id}`).expect(404);
    await editor.delete(`/content/banners/${banner.id}`).expect(404);
    expect(await prisma.contentImage.count({ where: { id: { in: [desktop.id, mobile.id] } } })).toBe(2);
  });

  it('audits create, update and delete readably, with photo ids and no image data', async () => {
    const entries = (await audit('banner')).filter((e) => e.entityId === String(banner.id));
    expect(entries.map((e) => e.action)).toEqual([
      'content.banner.delete',
      'content.banner.update',
      'content.banner.create',
    ]);
    const [deleted, update, create] = entries;
    expect(create.after).toMatchObject({
      שם: 'ZZ מבצע סלון',
      קישור: '/category/sofas',
      תמונה: `#${desktop.id}`,
      'תמונה לנייד': `#${mobile.id}`,
      פעיל: 'כן',
    });
    // Only the changed keys.
    expect(update.before).toEqual({ כותרת: 'ספות חדשות לסלון', 'תמונה לנייד': `#${mobile.id}`, סיום: '' });
    expect(update.after).toEqual({ כותרת: 'ספות לחורף', 'תמונה לנייד': '', סיום: '2026-12-31T21:59:59.999Z' });
    // A deleted banner is still named in the log.
    expect(deleted).toMatchObject({ entityLabel: 'ZZ מבצע סלון', after: null });
    expect(JSON.stringify(entries)).not.toMatch(/webp|avif|base64/);
  });
});
