import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import type {
  AdminContentImage,
  AdminLandingPage,
  AdminLandingPageInput,
  AdminLandingPreview,
  AuditPage,
  LandingResponse,
  OneTimeLink,
  SitemapData,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { DiscountType, PromotionKind, PromotionTarget } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, ORIGIN, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/**
 * Landing pages (Phase 8 §4.7, §9, MKT-02, decision 97). The e2e database persists between runs: every landing page
 * this file creates has a slug starting with "zz-", every promotion a name starting with "ZZ", and every content image
 * row and file it uploads is removed in afterAll.
 */
describe('Content landing pages (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let cache: CacheStore;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let service: AdminBrowser;
  const media = process.env.MEDIA_DIR!;
  const createdImages: number[] = [];
  const PROMO = 'ZZ עמוד נחיתה';

  const site = (url: string) => request(app.getHttpServer()).get(url);
  const landing = (slug: string, preview?: string) =>
    site(`/api/content/landing/${slug}${preview === undefined ? '' : `?preview=${encodeURIComponent(preview)}`}`);
  const sitemap = async () => (await site('/api/seo/sitemap').expect(200)).body as SitemapData;
  const fresh = () => cache.invalidate('content:');
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();
  const tokenOf = (preview: AdminLandingPreview) => new URL(preview.url).searchParams.get('preview')!;

  const jpeg = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 150, g: 130, b: 110 } } })
      .jpeg()
      .toBuffer();
  const uploaded = async () => {
    const res = await editor.agent
      .post('/api/admin/content/images')
      .set('Origin', ORIGIN)
      .attach('file', await jpeg(1400, 1000), 'photo.jpg')
      .expect(201);
    const body = res.body as AdminContentImage;
    createdImages.push(body.id);
    return body;
  };

  let desktop: AdminContentImage;
  let mobile: AdminContentImage;
  let productIds: number[];
  const input = (over: Partial<AdminLandingPageInput> | Record<string, unknown> = {}): AdminLandingPageInput => ({
    slug: 'zz-winter',
    titleHe: 'ZZ קולקציית חורף',
    sublineHe: 'ספות ובדים חמים',
    introHtml: '<h2>חם בסלון</h2><p>בחרנו בשבילכם</p>',
    outroHtml: '<p>עד גמר המלאי</p>',
    imageId: desktop.id,
    mobileImageId: mobile.id,
    altHe: 'ספה בסלון חורפי',
    source: { kind: 'manual', productIds },
    status: 'published',
    startsAt: null,
    endsAt: null,
    endedLinkUrl: null,
    metaDescriptionHe: 'ספות לחורף',
    noindex: false,
    ...over,
  });
  const create = async (over: Partial<AdminLandingPageInput> | Record<string, unknown> = {}) =>
    (await editor.post('/content/landing', input(over)).expect(201)).body as AdminLandingPage;
  const bodyOf = (p: AdminLandingPage, over: Partial<AdminLandingPageInput> = {}) => ({
    slug: p.slug,
    titleHe: p.titleHe,
    sublineHe: p.sublineHe,
    introHtml: p.introHtml,
    outroHtml: p.outroHtml,
    imageId: p.imageId,
    mobileImageId: p.mobileImageId,
    altHe: p.altHe,
    source: p.source,
    status: p.status,
    startsAt: p.startsAt,
    endsAt: p.endsAt,
    endedLinkUrl: p.endedLinkUrl,
    metaDescriptionHe: p.metaDescriptionHe,
    noindex: p.noindex,
    expectedUpdatedAt: p.updatedAt,
    ...over,
  });

  const cleanup = async () => {
    await prisma.landingPage.deleteMany({ where: { slug: { startsWith: 'zz-' } } });
    await prisma.promotion.deleteMany({ where: { name: { startsWith: PROMO } } });
    const rows = await prisma.contentImage.findMany({ where: { id: { in: createdImages } } });
    await prisma.contentImage.deleteMany({ where: { id: { in: createdImages } } });
    for (const row of rows) {
      for (const w of row.widths)
        for (const f of ['webp', 'avif'])
          await rm(join(media, 'public', `${row.storageKey}-${w}.${f}`), { force: true });
      await rm(join(media, 'private', 'originals', `${row.storageKey}.${row.originalExt}`), { force: true });
    }
    await fresh();
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    cache = app.get(CacheStore);
    await resetAdminData(prisma);
    await cleanup();
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    const created = await owner
      .post('/users', { email: 'service@example.test', name: 'שירות', template: 'customer_service' })
      .expect(201);
    service = await acceptAndSignIn(
      app,
      { email: 'service@example.test', password: 'velvet chair morning tide' },
      created.body.invite as OneTimeLink,
    );
    desktop = await uploaded();
    mobile = await uploaded();
    const products = await prisma.product.findMany({
      where: { slug: { in: ['alba-corner-sofa', 'luna-armchair'] } },
      select: { id: true, slug: true },
    });
    // In this order: ALBA, then LUNA.
    productIds = ['alba-corner-sofa', 'luna-armchair'].map((s) => products.find((p) => p.slug === s)!.id);
  });

  afterAll(async () => {
    await cleanup();
    await resetAdminData(prisma);
    await app.close();
  });

  afterEach(async () => {
    await prisma.landingPage.deleteMany({ where: { slug: { startsWith: 'zz-' } } });
    await prisma.promotion.deleteMany({ where: { name: { startsWith: PROMO } } });
    await fresh();
  });

  it('needs content.manage for the admin endpoints: 403 for a user without it', async () => {
    await service.get('/content/landing').expect(403);
    await service.get('/content/landing/1').expect(403);
    await service.post('/content/landing', input()).expect(403);
    await service.put('/content/landing/1', input()).expect(403);
    await service.delete('/content/landing/1').expect(403);
    await service.post('/content/landing/1/preview').expect(403);
  });

  it('creates a page: sanitized texts, photos, default ended link, state and source marks', async () => {
    const page = await create({
      introHtml:
        '<h2>חם בסלון</h2><script>alert(1)</script><p onclick="x()">בחרנו <a href="javascript:x">בשבילכם</a></p>',
      outroHtml: '<h2>כותרת</h2><p>עד גמר המלאי</p>',
      sublineHe: '  ',
    });
    expect(page).toMatchObject({
      slug: 'zz-winter',
      titleHe: 'ZZ קולקציית חורף',
      sublineHe: null,
      introHtml: '<h2>חם בסלון</h2><p>בחרנו בשבילכם</p>',
      imageId: desktop.id,
      mobileImageId: mobile.id,
      source: { kind: 'manual', productIds },
      status: 'published',
      state: 'live',
      endedLinkUrl: '/',
      unavailable: { productIds: [], source: false },
      sourceLink: null,
    });
    // Inline mode: no headings.
    expect(page.outroHtml).not.toContain('<h2>');
    expect(page.outroHtml).toContain('<p>עד גמר המלאי</p>');
    expect(page.image).toMatchObject({ url: desktop.image.url, altHe: 'ספה בסלון חורפי' });
    expect(page.mobileImage).toMatchObject({ url: mobile.image.url });

    const list = (await editor.get('/content/landing').expect(200)).body as AdminLandingPage[];
    expect(list.map((p) => p.id)).toContain(page.id);
    expect((await editor.get(`/content/landing/${page.id}`).expect(200)).body).toEqual(page);
    await editor.get('/content/landing/999999').expect(404);

    // A closing text with no words is none; a category source offers its listing as the ended-link shortcut.
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const other = await create({
      slug: 'zz-sofas',
      outroHtml: '<p> </p>',
      mobileImageId: null,
      source: { kind: 'category', id: sofas.id },
      status: 'draft',
    });
    expect(other).toMatchObject({ outroHtml: null, mobileImage: null, state: 'draft', sourceLink: '/category/sofas' });
  });

  it('slug rules: lower-case English words with single dashes, at most 80, unique (409 slug_taken)', async () => {
    for (const slug of ['', 'ZZ-Winter', 'zz winter', 'zz--winter', '-zz', 'zz-', 'חורף', `zz-${'a'.repeat(78)}`])
      expect((await editor.post('/content/landing', input({ slug })).expect(400)).body).toMatchObject({
        code: 'invalid',
        field: 'slug',
      });
    await create({ slug: `zz-${'a'.repeat(77)}` });
    const first = await create();
    expect((await editor.post('/content/landing', input()).expect(409)).body).toMatchObject({
      code: 'slug_taken',
      field: 'slug',
    });
    const second = await create({ slug: 'zz-winter-2' });
    expect(
      (await editor.put(`/content/landing/${second.id}`, bodyOf(second, { slug: first.slug })).expect(409)).body,
    ).toMatchObject({ code: 'slug_taken' });
    // Renaming to a free slug works; the old address is then unknown.
    await editor.put(`/content/landing/${second.id}`, bodyOf(second, { slug: 'zz-winter-sale' })).expect(200);
    await landing('zz-winter-2').expect(404);
    await landing('zz-winter-sale').expect(200);
  });

  it('the ended link is a site path or an https address (invalid_link otherwise); empty means "/"', async () => {
    for (const endedLinkUrl of [
      'mailto:a@example.com',
      'tel:035551234',
      'javascript:alert(1)',
      '//evil.example/x',
      'http://plain.example',
      'data:text/html,x',
      'category/sofas',
    ])
      expect((await editor.post('/content/landing', input({ endedLinkUrl })).expect(400)).body).toMatchObject({
        code: 'invalid_link',
        field: 'endedLinkUrl',
      });
    expect((await create({ endedLinkUrl: '/category/sofas' })).endedLinkUrl).toBe('/category/sofas');
    expect((await create({ slug: 'zz-ext', endedLinkUrl: 'https://example.com/sale' })).endedLinkUrl).toBe(
      'https://example.com/sale',
    );
    expect((await create({ slug: 'zz-empty', endedLinkUrl: '' })).endedLinkUrl).toBe('/');
  });

  it('refuses other bad fields with invalid, and promotion sources that are not allowed with invalid_source', async () => {
    const bad = async (over: Record<string, unknown>, field: string, code = 'invalid') =>
      expect((await editor.post('/content/landing', input(over)).expect(400)).body).toMatchObject({ code, field });
    await bad({ titleHe: ' ' }, 'titleHe');
    await bad({ titleHe: 'x'.repeat(121) }, 'titleHe');
    await bad({ sublineHe: 'x'.repeat(161) }, 'sublineHe');
    await bad({ introHtml: '<p> </p>' }, 'introHtml');
    await bad({ introHtml: null }, 'introHtml');
    await bad({ altHe: '' }, 'altHe');
    await bad({ imageId: 999_999 }, 'imageId');
    await bad({ imageId: null }, 'imageId');
    await bad({ mobileImageId: 999_999 }, 'mobileImageId');
    await bad({ status: 'live' }, 'status');
    await bad({ noindex: 'no' }, 'noindex');
    await bad({ metaDescriptionHe: 'x'.repeat(161) }, 'metaDescriptionHe');
    await bad({ startsAt: '2026-12-31T22:00:00.000Z', endsAt: '2026-12-01T21:59:59.999Z' }, 'endsAt');
    await bad({ source: { kind: 'carousel' } }, 'source.kind');
    await bad({ source: { kind: 'category', id: 999_999 } }, 'source.id');
    await bad({ source: { kind: 'room', id: 999_999 } }, 'source.id');
    await bad({ source: { kind: 'manual', productIds: [] } }, 'source.productIds');
    await bad({ source: { kind: 'manual', productIds: [999_999] } }, 'source.productIds');
    await bad({ source: { kind: 'promotion', id: 999_999 } }, 'source', 'invalid_source');

    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const promo = (
      data: Partial<{ kind: PromotionKind; target: PromotionTarget; membersOnly: boolean; code: string }>,
    ) =>
      prisma.promotion.create({
        data: {
          name: PROMO,
          kind: PromotionKind.AUTOMATIC,
          discountType: DiscountType.PERCENT,
          value: 10,
          target: PromotionTarget.CATEGORIES,
          targetIds: [sofas.id],
          ...data,
        },
      });
    for (const p of [
      await promo({ target: PromotionTarget.ORDER }),
      await promo({ membersOnly: true }),
      await promo({ kind: PromotionKind.COUPON, code: 'ZZLAND10' }),
    ])
      await bad({ source: { kind: 'promotion', id: p.id } }, 'source', 'invalid_source');
    expect(await prisma.landingPage.count({ where: { slug: { startsWith: 'zz-' } } })).toBe(0);
  });

  it('landing visibility: draft and not started → 404 with nothing of the page, live → 200, ended → 410', async () => {
    const unknown = await landing('zz-nothing-here').expect(404);
    expect(unknown.body).toEqual({ statusCode: 404, code: 'not_found' });

    const draft = await create({ status: 'draft' });
    const hidden = await landing('zz-winter').expect(404);
    expect(hidden.body).toEqual(unknown.body);
    expect(JSON.stringify(hidden.body)).not.toContain('חורף');

    const scheduled = await create({ slug: 'zz-soon', startsAt: day(1) });
    expect(scheduled.state).toBe('scheduled');
    expect((await landing('zz-soon').expect(404)).body).toEqual(unknown.body);

    // Publishing shows it at once (the save clears the content cache).
    const published = (
      await editor.put(`/content/landing/${draft.id}`, bodyOf(draft, { status: 'published' })).expect(200)
    ).body as AdminLandingPage;
    const live = await landing('zz-winter').expect(200);
    expect(live.headers['cache-control']).toBeUndefined();
    const body = live.body as LandingResponse;
    expect(body.state).toBe('live');
    expect(body.page).toMatchObject({
      slug: 'zz-winter',
      titleHe: 'ZZ קולקציית חורף',
      sublineHe: 'ספות ובדים חמים',
      introHtml: '<h2>חם בסלון</h2><p>בחרנו בשבילכם</p>',
      outroHtml: '<p>עד גמר המלאי</p>',
      altHe: 'ספה בסלון חורפי',
      metaDescriptionHe: 'ספות לחורף',
      noindex: false,
    });
    expect(body.page.image.url).toBe(desktop.image.url);
    expect(body.page.mobileImage?.url).toBe(mobile.image.url);
    // Manual picks in their order; the newest order lists the same ids.
    expect(body.page.items.map((c) => c.id)).toEqual(productIds);
    const asc = (a: number, b: number) => a - b;
    expect([...body.page.newestOrder].sort(asc)).toEqual([...productIds].sort(asc));
    expect(body.page).not.toHaveProperty('status');
    expect(body.page).not.toHaveProperty('id');

    // Ended yesterday → 410 with the title and the ended link only.
    await editor
      .put(
        `/content/landing/${published.id}`,
        bodyOf(published, { startsAt: day(-10), endsAt: day(-1), endedLinkUrl: '/category/sofas' }),
      )
      .expect(200);
    const gone = await landing('zz-winter').expect(410);
    expect(gone.body).toEqual({ state: 'ended', titleHe: 'ZZ קולקציית חורף', endedLinkUrl: '/category/sofas' });

    // A started page whose end is later today (inclusive end) is live.
    await prisma.landingPage.update({
      where: { id: published.id },
      data: { startsAt: new Date(day(-1)), endsAt: new Date(Date.now() + 60_000) },
    });
    await fresh();
    expect((await landing('zz-winter').expect(200)).body.state).toBe('live');

    // A slug that is not one never reaches the database.
    await landing('ZZ-WINTER').expect(404);
  });

  it('a live page shows nothing more once its promotion ends, but the page itself stays', async () => {
    const armchairs = await prisma.category.findUniqueOrThrow({ where: { slug: 'armchairs' } });
    const promotion = await prisma.promotion.create({
      data: {
        name: `${PROMO} כורסאות`,
        kind: PromotionKind.AUTOMATIC,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.CATEGORIES,
        targetIds: [armchairs.id],
        startsAt: new Date(day(-1)),
        endsAt: new Date(day(1)),
      },
    });
    const page = await create({ source: { kind: 'promotion', id: promotion.id } });
    const items = ((await landing('zz-winter').expect(200)).body as LandingResponse).page.items;
    expect(items.length).toBeGreaterThan(0);

    await prisma.promotion.update({ where: { id: promotion.id }, data: { endsAt: new Date(day(-1)) } });
    await fresh();
    expect(((await landing('zz-winter').expect(200)).body as LandingResponse).page.items).toEqual([]);
    // The admin marks the source, and the page still saves with it (it is unchanged).
    const marked = (await editor.get(`/content/landing/${page.id}`).expect(200)).body as AdminLandingPage;
    expect(marked.unavailable.source).toBe(true);
    await editor.put(`/content/landing/${page.id}`, bodyOf(marked, { titleHe: 'ZZ אחרי המבצע' })).expect(200);
  });

  it('preview: a signed token shows a draft, a scheduled or an ended page, no-store; wrong tokens get the public answer', async () => {
    const draft = await create({ status: 'draft' });
    const live = await create({ slug: 'zz-live' });

    const res = await editor.post(`/content/landing/${draft.id}/preview`).expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const preview = res.body as AdminLandingPreview;
    expect(preview.url).toMatch(/^https?:\/\/[^/]+\/collection\/zz-winter\?preview=[^&]+$/);
    const expires = new Date(preview.expiresAt).getTime();
    expect(expires - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(expires - Date.now()).toBeLessThanOrEqual(30 * 60_000);
    const token = tokenOf(preview);

    const shown = await landing('zz-winter', token).expect(200);
    expect(shown.headers['cache-control']).toBe('no-store');
    expect(shown.body).toMatchObject({ state: 'preview', page: { slug: 'zz-winter', titleHe: 'ZZ קולקציית חורף' } });

    // Not started yet, and ended: the preview still shows it.
    await prisma.landingPage.update({
      where: { id: draft.id },
      data: { status: 'PUBLISHED', startsAt: new Date(day(3)) },
    });
    expect((await landing('zz-winter', token).expect(200)).body.state).toBe('preview');
    await prisma.landingPage.update({
      where: { id: draft.id },
      data: { startsAt: new Date(day(-5)), endsAt: new Date(day(-1)) },
    });
    await fresh();
    expect((await landing('zz-winter', token).expect(200)).body.state).toBe('preview');
    expect((await landing('zz-winter').expect(410)).body.state).toBe('ended');
    await prisma.landingPage.update({ where: { id: draft.id }, data: { status: 'DRAFT' } });
    await fresh();

    // Bound to the page: the token of the draft does not open another page, and a live page answers as live.
    const otherDraft = await create({ slug: 'zz-other', status: 'draft' });
    const wrong = await landing('zz-other', token).expect(404);
    expect(wrong.body).toEqual({ statusCode: 404, code: 'not_found' });
    expect(wrong.headers['cache-control']).toBe('no-store');
    const asLive = await landing('zz-live', token).expect(200);
    expect(asLive.body.state).toBe('live');
    expect(asLive.headers['cache-control']).toBe('no-store');

    // Tampered or junk tokens.
    const [id, exp, sig] = token.split('.');
    await landing('zz-other', `${otherDraft.id}.${exp}.${sig}`).expect(404);
    for (const t of [
      `${id}.${Number(exp) + 3_600_000}.${sig}`,
      `${id}.${exp}.${sig.slice(0, -1)}${sig.endsWith('A') ? 'B' : 'A'}`,
      'x',
      '',
    ])
      await landing('zz-winter', t).expect(404);

    await editor.post('/content/landing/999999/preview').expect(404);
    expect(live.state).toBe('live');
  });

  it('the preview link is audited without its token', async () => {
    const page = await create({ status: 'draft' });
    const preview = (await editor.post(`/content/landing/${page.id}/preview`).expect(200)).body as AdminLandingPreview;
    const entries = ((await owner.get('/audit?entityType=landing_page').expect(200)).body as AuditPage).items.filter(
      (e) => e.entityId === String(page.id),
    );
    const logged = entries.find((e) => e.action === 'content.landing.preview');
    expect(logged?.after).toEqual({ כתובת: '/collection/zz-winter', 'בתוקף עד': preview.expiresAt });
    expect(JSON.stringify(entries)).not.toContain(tokenOf(preview));
    expect(JSON.stringify(entries)).not.toContain(tokenOf(preview).split('.')[2]);
  });

  it('sitemap lists only live, indexable landing pages', async () => {
    await create({ slug: 'zz-live' });
    await create({ slug: 'zz-draft', status: 'draft' });
    await create({ slug: 'zz-soon', startsAt: day(2) });
    await create({ slug: 'zz-over', startsAt: day(-5), endsAt: day(-1) });
    await create({ slug: 'zz-hidden', noindex: true });
    const mine = (await sitemap()).landingPages.filter((p) => p.slug.startsWith('zz-'));
    expect(mine.map((p) => p.slug)).toEqual(['zz-live']);
    expect(mine[0].updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('updates with expectedUpdatedAt; a stale save is a 409 conflict', async () => {
    const page = await create();
    const updated = (
      await editor
        .put(`/content/landing/${page.id}`, bodyOf(page, { titleHe: 'ZZ חורף חם', mobileImageId: null }))
        .expect(200)
    ).body as AdminLandingPage;
    expect(updated).toMatchObject({ titleHe: 'ZZ חורף חם', mobileImageId: null, mobileImage: null });
    expect(
      (await editor.put(`/content/landing/${page.id}`, bodyOf(page, { titleHe: 'ישן' })).expect(409)).body,
    ).toMatchObject({ code: 'conflict' });
    const { expectedUpdatedAt: _e, ...noStamp } = bodyOf(updated);
    expect((await editor.put(`/content/landing/${page.id}`, noStamp).expect(400)).body).toMatchObject({
      field: 'expectedUpdatedAt',
    });
    await editor.put('/content/landing/999999', bodyOf(updated)).expect(404);
  });

  it('an image a landing page uses cannot be deleted (Restrict); deleting the page keeps its images', async () => {
    const spare = await uploaded();
    const page = await create({ imageId: spare.id, mobileImageId: null });
    await expect(prisma.contentImage.delete({ where: { id: spare.id } })).rejects.toThrow();
    await editor.delete(`/content/landing/${page.id}`).expect(204);
    await editor.get(`/content/landing/${page.id}`).expect(404);
    await editor.delete(`/content/landing/${page.id}`).expect(404);
    await landing('zz-winter').expect(404);
    expect(await prisma.contentImage.count({ where: { id: spare.id } })).toBe(1);
  });

  it('audits create, update and delete readably, with photo ids and no image data', async () => {
    const page = await create();
    await editor
      .put(`/content/landing/${page.id}`, bodyOf(page, { titleHe: 'ZZ חורף חם', status: 'draft' }))
      .expect(200);
    await editor.delete(`/content/landing/${page.id}`).expect(204);
    const entries = ((await owner.get('/audit?entityType=landing_page').expect(200)).body as AuditPage).items.filter(
      (e) => e.entityId === String(page.id),
    );
    expect(entries.map((e) => e.action)).toEqual([
      'content.landing.delete',
      'content.landing.update',
      'content.landing.create',
    ]);
    const [deleted, update, created] = entries;
    expect(created.after).toMatchObject({
      כותרת: 'ZZ קולקציית חורף',
      כתובת: '/collection/zz-winter',
      תמונה: `#${desktop.id}`,
      'תמונה לנייד': `#${mobile.id}`,
      מוצרים: `בחירה ידנית: ${productIds.map((id) => `#${id}`).join(', ')}`,
      מפורסם: 'כן',
      'קישור אחרי הסיום': '/',
    });
    expect(update.before).toEqual({ כותרת: 'ZZ קולקציית חורף', מפורסם: 'כן' });
    expect(update.after).toEqual({ כותרת: 'ZZ חורף חם', מפורסם: 'לא' });
    expect(deleted).toMatchObject({ entityLabel: 'ZZ חורף חם', after: null });
    expect(JSON.stringify(entries)).not.toMatch(/webp|avif|base64/);
  });
});
