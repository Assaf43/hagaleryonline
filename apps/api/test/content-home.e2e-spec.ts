import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import sharp from 'sharp';
import request from 'supertest';
import type {
  AdminBanner,
  AdminBannerInput,
  AdminContentImage,
  AdminHome,
  AdminHomeSectionInput,
  AuditPage,
  CategoryNode,
  HomeSectionView,
  HomeView,
  OneTimeLink,
  ProductListResponse,
  RoomMenuItem,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { DiscountType, HomeSectionKind, PromotionKind, PromotionTarget } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, ORIGIN, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/**
 * The managed home page (Phase 8 §4.6, §9, NAV-05, decision 98). The e2e database persists between runs: the sections
 * are put back to the migration's default rows before and after this file, and every banner ("ZZ…"), content image and
 * promotion ("ZZ…") it creates is removed.
 */
describe('Content home page (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let cache: CacheStore;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let service: AdminBrowser;
  const media = process.env.MEDIA_DIR!;
  const createdImages: number[] = [];
  const PROMO = 'ZZ דף הבית';

  const site = <T>(url: string) =>
    request(app.getHttpServer())
      .get(url)
      .expect(200)
      .then((r) => r.body as T);
  const home = () => site<HomeView>('/api/content/home');
  const kinds = (view: HomeView) => view.sections.map((s) => s.kind);
  const section = <K extends HomeSectionView['kind']>(view: HomeView, kind: K, nth = 0) =>
    view.sections.filter((s) => s.kind === kind)[nth] as Extract<HomeSectionView, { kind: K }>;
  const adminHome = async () => (await editor.get('/content/home').expect(200)).body as AdminHome;
  /** The admin list as a save body (what the screen sends back). */
  const asInput = (h: AdminHome): AdminHomeSectionInput[] =>
    h.sections.map(({ unavailable: _u, ...s }) => s as AdminHomeSectionInput);
  const save = (sections: AdminHomeSectionInput[], expectedUpdatedAt: string) =>
    editor.put('/content/home', { sections, expectedUpdatedAt });
  /** Content rows changed straight in the database: drop the cached copies. */
  const fresh = () => cache.invalidate('content:');

  const DEFAULT_SECTIONS = [
    { sortOrder: 0, kind: HomeSectionKind.HERO, titleHe: null, config: { bannerIds: [] } },
    { sortOrder: 1, kind: HomeSectionKind.TRUST, titleHe: null, config: {} },
    { sortOrder: 2, kind: HomeSectionKind.ROOMS, titleHe: null, config: {} },
    {
      sortOrder: 3,
      kind: HomeSectionKind.PRODUCTS,
      titleHe: 'הנמכרים ביותר',
      config: { source: { kind: 'bestsellers' }, count: 4 },
    },
    {
      sortOrder: 4,
      kind: HomeSectionKind.PRODUCTS,
      titleHe: 'חדש באתר',
      config: { source: { kind: 'newest' }, count: 4 },
    },
  ];
  /** The migration's default rows (today's home page). */
  const restoreHome = async () => {
    await prisma.homeSection.deleteMany();
    await prisma.homeSection.createMany({ data: DEFAULT_SECTIONS.map((s) => ({ ...s, visible: true })) });
    await fresh();
  };

  const jpeg = (width: number, height: number) =>
    sharp({ create: { width, height, channels: 3, background: { r: 120, g: 140, b: 160 } } })
      .jpeg()
      .toBuffer();
  let photo: AdminContentImage;
  const banner = async (over: Partial<AdminBannerInput> = {}) => {
    const input: AdminBannerInput = {
      nameHe: 'ZZ באנר בית',
      headlineHe: 'ספות לסלון',
      sublineHe: null,
      ctaLabelHe: 'לכל הספות',
      linkUrl: '/category/sofas',
      imageId: photo.id,
      mobileImageId: null,
      altHe: 'ספה בסלון',
      active: true,
      startsAt: null,
      endsAt: null,
      ...over,
    };
    return (await editor.post('/content/banners', input).expect(201)).body as AdminBanner;
  };
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString();

  const cleanup = async () => {
    await prisma.homeSection.deleteMany();
    await prisma.banner.deleteMany({ where: { nameHe: { startsWith: 'ZZ' } } });
    await prisma.promotion.deleteMany({ where: { name: { startsWith: PROMO } } });
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
    cache = app.get(CacheStore);
    await resetAdminData(prisma);
    await cleanup();
    await restoreHome();
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    const created = await owner
      .post('/users', { email: 'service@example.test', name: 'שירות', template: 'customer_service' })
      .expect(201);
    service = await acceptAndSignIn(
      app,
      { email: 'service@example.test', password: 'velvet chair morning tide' },
      created.body.invite as OneTimeLink,
    );
    const upload = await editor.agent
      .post('/api/admin/content/images')
      .set('Origin', ORIGIN)
      .attach('file', await jpeg(1400, 1000), 'photo.jpg')
      .expect(201);
    photo = upload.body as AdminContentImage;
    createdImages.push(photo.id);
  });

  afterAll(async () => {
    await cleanup();
    await restoreHome();
    await resetAdminData(prisma);
    await app.close();
  });

  afterEach(async () => {
    // Every test starts from today's page.
    await restoreHome();
  });

  it('needs content.manage for the admin endpoints: 403 for a user without it', async () => {
    await service.get('/content/home').expect(403);
    await service.put('/content/home', { sections: [], expectedUpdatedAt: new Date().toISOString() }).expect(403);
  });

  it('promotion-sources: a content editor lists usable and ended promotions; 403 without content.manage', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const make = (data: Record<string, unknown>) =>
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
    const live = await make({ name: `${PROMO} חי` });
    const ended = await make({ name: `${PROMO} הסתיים`, endsAt: new Date(day(-1)) });
    const order = await make({ target: PromotionTarget.ORDER });
    const members = await make({ membersOnly: true });
    const coupon = await make({ kind: PromotionKind.COUPON, code: 'ZZSRC10' });

    await service.get('/content/promotion-sources').expect(403);
    const list = (await editor.get('/content/promotion-sources').expect(200)).body as {
      id: number;
      name: string;
      usable: boolean;
    }[];
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get(live.id)).toEqual({ id: live.id, name: `${PROMO} חי`, usable: true });
    expect(byId.get(ended.id)?.usable).toBe(false);
    for (const p of [order, members, coupon]) expect(byId.has(p.id)).toBe(false);
    await prisma.promotion.deleteMany({ where: { name: { startsWith: PROMO } } });
  });

  it("the default sections reproduce today's home page", async () => {
    const view = await home();
    expect(kinds(view)).toEqual(['hero', 'trust', 'rooms', 'products', 'products']);

    const [best, newest, rooms, categories] = await Promise.all([
      site<ProductListResponse>('/api/products?sort=bestsellers&pageSize=4'),
      site<ProductListResponse>('/api/products?sort=newest&pageSize=4'),
      site<RoomMenuItem[]>('/api/rooms'),
      site<CategoryNode[]>('/api/categories'),
    ]);
    expect(best.items.length).toBe(4);

    const hero = section(view, 'hero');
    expect(hero.banner).toBeNull();
    expect(hero.fallback).toEqual({
      image: best.items[0].image,
      category: { slug: categories[0].slug, nameHe: categories[0].nameHe },
      room: { slug: rooms[0].slug, nameHe: rooms[0].nameHe },
    });

    // Rooms → furniture types as the menu lists them, each tile with its category's first product photo.
    const tiles = section(view, 'rooms').rooms;
    expect(
      tiles.map((r) => ({
        slug: r.slug,
        nameHe: r.nameHe,
        categories: r.categories.map(({ slug, nameHe }) => ({ slug, nameHe })),
      })),
    ).toEqual(rooms);
    for (const room of tiles) {
      for (const c of room.categories) {
        const first = await site<ProductListResponse>(`/api/products?category=${c.slug}&pageSize=1`);
        expect(c.image).toEqual(first.items[0]?.image ?? null);
        expect(c.image).not.toBeNull();
      }
    }

    const [bestRow, newRow] = [section(view, 'products', 0), section(view, 'products', 1)];
    expect(bestRow).toMatchObject({ titleHe: 'הנמכרים ביותר', link: null });
    expect(bestRow.items).toEqual(best.items);
    expect(newRow).toMatchObject({ titleHe: 'חדש באתר', link: null });
    expect(newRow.items).toEqual(newest.items);
  });

  it('the admin reads every section in order with the newest stamp', async () => {
    const h = await adminHome();
    expect(h.sections.map((s) => s.kind)).toEqual(['hero', 'trust', 'rooms', 'products', 'products']);
    expect(h.sections[0]).toMatchObject({ kind: 'hero', bannerIds: [], titleHe: null, visible: true });
    expect(h.sections[3]).toMatchObject({ source: { kind: 'bestsellers' }, count: 4, titleHe: 'הנמכרים ביותר' });
    for (const s of h.sections)
      expect(s.unavailable).toEqual({ bannerIds: [], categoryIds: [], productIds: [], source: false });
    const rows = await prisma.homeSection.findMany();
    const newest = new Date(Math.max(...rows.map((r) => r.updatedAt.getTime()))).toISOString();
    expect(h.updatedAt).toBe(newest);
  });

  it('saves the whole list: order, titles, hidden sections, new kinds, removals; audited', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    // Another furniture type with products on the site.
    const shown = (await site<CategoryNode[]>('/api/categories')).find((c) => c.slug !== 'sofas')!;
    const others = [await prisma.category.findUniqueOrThrow({ where: { slug: shown.slug } })];
    const live = await banner({ nameHe: 'ZZ זוג 1', headlineHe: 'ראשון' });
    const second = await banner({ nameHe: 'ZZ זוג 2', headlineHe: 'שני' });
    const before = await adminHome();
    const [hero, trust, rooms, best] = asInput(before);

    const res = await save(
      [
        { ...hero, bannerIds: [live.id] } as AdminHomeSectionInput,
        { kind: 'categories', categoryIds: [sofas.id, others[0].id], titleHe: 'לפי סוג', visible: true },
        { kind: 'products', source: { kind: 'category', id: sofas.id }, count: 8, titleHe: 'ספות', visible: true },
        { kind: 'banner_pair', bannerIds: [second.id, live.id], titleHe: null, visible: true },
        { ...trust, visible: false },
        rooms,
        best,
      ],
      before.updatedAt,
    ).expect(200);
    const saved = res.body as AdminHome;
    expect(saved.sections.map((s) => s.kind)).toEqual([
      'hero',
      'categories',
      'products',
      'banner_pair',
      'trust',
      'rooms',
      'products',
    ]);
    expect(saved.sections[0].id).toBe(hero.id);
    expect(saved.sections[4]).toMatchObject({ id: trust.id, visible: false });
    expect(await prisma.homeSection.count()).toBe(7);

    const view = await home();
    expect(kinds(view)).toEqual(['hero', 'categories', 'products', 'banner_pair', 'rooms', 'products']);
    expect(section(view, 'hero').banner).toMatchObject({
      id: live.id,
      headlineHe: 'ראשון',
      linkUrl: '/category/sofas',
    });
    expect(section(view, 'hero').banner?.image.url).toMatch(/^\/media\/content\//);
    const cats = section(view, 'categories');
    expect(cats.titleHe).toBe('לפי סוג');
    expect(cats.categories.map((c) => c.slug)).toEqual(['sofas', others[0].slug]);
    const first = await site<ProductListResponse>('/api/products?category=sofas&pageSize=1');
    expect(cats.categories[0].image).toEqual(first.items[0].image);
    const row = section(view, 'products', 0);
    expect(row.link).toBe('/category/sofas');
    expect(row.items).toEqual((await site<ProductListResponse>('/api/products?category=sofas&pageSize=8')).items);
    expect(section(view, 'banner_pair').banners.map((b) => b.id)).toEqual([second.id, live.id]);

    const entries = ((await owner.get('/audit?entityType=home_page').expect(200)).body as AuditPage).items;
    expect(entries[0]).toMatchObject({ action: 'content.home.update', entityId: '1' });
    expect(entries[0].after).toMatchObject({
      'מקום 1': `באנר ראשי · מוצג · באנרים: #${live.id}`,
      'מקום 2': expect.stringContaining('אריחי קטגוריות · "לפי סוג" · מוצג · קטגוריות:'),
      'מקום 5': 'שורת יתרונות · מוסתר',
    });
    expect(entries[0].before).toMatchObject({ 'מקום 1': 'באנר ראשי · מוצג · באנרים: אין' });
  });

  it('a stale or missing stamp is refused', async () => {
    const h = await adminHome();
    await save(asInput(h), h.updatedAt).expect(200);
    const res = await save(asInput(h), h.updatedAt).expect(409);
    expect(res.body).toMatchObject({ code: 'conflict' });
    await editor.put('/content/home', { sections: asInput(h) }).expect(400);
  });

  it('checks each section by kind', async () => {
    const h = await adminHome();
    const base = asInput(h);
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const bad = async (extra: unknown, field: string, code = 'invalid') => {
      const res = await editor
        .put('/content/home', { sections: [...base, extra], expectedUpdatedAt: h.updatedAt })
        .expect(400);
      expect(res.body).toMatchObject({ code, field: `sections.${base.length}.${field}` });
    };
    const products = (source: unknown, count = 4) => ({
      kind: 'products',
      source,
      count,
      titleHe: null,
      visible: true,
    });

    await bad({ kind: 'categories', categoryIds: [sofas.id], titleHe: null, visible: true }, 'categoryIds');
    await bad(
      { kind: 'categories', categoryIds: [1, 2, 3, 4, 5, 6, 7, 8, 9], titleHe: null, visible: true },
      'categoryIds',
    );
    await bad({ kind: 'categories', categoryIds: [sofas.id, sofas.id], titleHe: null, visible: true }, 'categoryIds');
    await bad({ kind: 'categories', categoryIds: [sofas.id, 999_999], titleHe: null, visible: true }, 'categoryIds');
    await bad({ kind: 'hero', bannerIds: [1, 2, 3, 4, 5, 6], titleHe: null, visible: true }, 'bannerIds');
    await bad({ kind: 'banner_pair', bannerIds: [1, 2, 3, 4, 5], titleHe: null, visible: true }, 'bannerIds');
    await bad({ kind: 'banner_pair', bannerIds: [999_999], titleHe: null, visible: true }, 'bannerIds');
    await bad(products({ kind: 'bestsellers' }, 5), 'count');
    await bad(products({ kind: 'everything' }), 'source.kind');
    await bad(products({ kind: 'category', id: 999_999 }), 'source.id');
    await bad(products({ kind: 'room', id: 999_999 }), 'source.id');
    await bad(products({ kind: 'manual', productIds: [] }), 'source.productIds');
    await bad(products({ kind: 'manual', productIds: [999_999] }), 'source.productIds');
    await bad(
      products({ kind: 'manual', productIds: Array.from({ length: 49 }, (_, i) => i + 1) }),
      'source.productIds',
    );
    await bad({ kind: 'carousel', titleHe: null, visible: true }, 'kind');
    await bad({ kind: 'trust', titleHe: null, visible: 'yes' }, 'visible');
    await bad({ kind: 'trust', titleHe: 'x'.repeat(121), visible: true }, 'titleHe');
    await bad({ id: 999_999, kind: 'trust', titleHe: null, visible: true }, 'id');

    // Promotion sources: only automatic, on categories or products, not members-only.
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
    const order = await promo({ target: PromotionTarget.ORDER });
    const members = await promo({ membersOnly: true });
    const coupon = await promo({ kind: PromotionKind.COUPON, code: 'ZZHOME10' });
    for (const p of [order, members, coupon])
      await bad(products({ kind: 'promotion', id: p.id }), 'source', 'invalid_source');
    await bad(products({ kind: 'promotion', id: 999_999 }), 'source', 'invalid_source');
    await prisma.promotion.deleteMany({ where: { id: { in: [order.id, members.id, coupon.id] } } });

    await editor.put('/content/home', { sections: [], expectedUpdatedAt: h.updatedAt }).expect(400);
    await editor
      .put('/content/home', {
        sections: Array.from({ length: 21 }, () => ({ kind: 'trust', titleHe: null, visible: true })),
        expectedUpdatedAt: h.updatedAt,
      })
      .expect(400);
    // Nothing was saved.
    expect((await adminHome()).updatedAt).toBe(h.updatedAt);
  });

  it('a promotion source shows its target products while the promotion is live, then hides', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const promotion = await prisma.promotion.create({
      data: {
        name: `${PROMO} ספות`,
        kind: PromotionKind.AUTOMATIC,
        discountType: DiscountType.PERCENT,
        value: 10,
        target: PromotionTarget.CATEGORIES,
        targetIds: [sofas.id],
        startsAt: new Date(day(-1)),
        endsAt: new Date(day(1)),
      },
    });
    const h = await adminHome();
    await save(
      [
        ...asInput(h),
        {
          kind: 'products',
          source: { kind: 'promotion', id: promotion.id },
          count: 4,
          titleHe: 'במבצע',
          visible: true,
        },
      ],
      h.updatedAt,
    ).expect(200);
    const row = section(await home(), 'products', 2);
    expect(row).toMatchObject({ titleHe: 'במבצע', link: null });
    expect(row.items).toEqual((await site<ProductListResponse>('/api/products?category=sofas&pageSize=4')).items);

    await prisma.promotion.update({ where: { id: promotion.id }, data: { endsAt: new Date(day(-0.5)) } });
    await fresh();
    expect(kinds(await home())).toEqual(['hero', 'trust', 'rooms', 'products', 'products']);
    const admin = await adminHome();
    expect(admin.sections[5].unavailable.source).toBe(true);
    // An ended promotion that the section already holds never blocks a save.
    await save(asInput(admin), admin.updatedAt).expect(200);
  });

  it('the hero falls back to the static hero when every banner ended; a pair shows only live banners', async () => {
    const ended = await banner({ nameHe: 'ZZ הסתיים', startsAt: day(-10), endsAt: day(-2) });
    const off = await banner({ nameHe: 'ZZ כבוי', active: false });
    const future = await banner({ nameHe: 'ZZ עתידי', startsAt: day(2), endsAt: day(9) });
    const live = await banner({ nameHe: 'ZZ חי', headlineHe: 'חי עכשיו' });
    const h = await adminHome();
    const [hero, ...rest] = asInput(h);
    await save(
      [
        { ...hero, bannerIds: [ended.id, off.id, future.id] } as AdminHomeSectionInput,
        { kind: 'banner_pair', bannerIds: [ended.id, off.id], titleHe: null, visible: true },
        { kind: 'banner_pair', bannerIds: [off.id, live.id, future.id], titleHe: null, visible: true },
        ...rest,
      ],
      h.updatedAt,
    ).expect(200);

    const view = await home();
    expect(kinds(view)).toEqual(['hero', 'banner_pair', 'trust', 'rooms', 'products', 'products']);
    const best = await site<ProductListResponse>('/api/products?sort=bestsellers&pageSize=1');
    expect(section(view, 'hero')).toMatchObject({ banner: null, fallback: { image: best.items[0].image } });
    expect(section(view, 'banner_pair').banners.map((b) => b.headlineHe)).toEqual(['חי עכשיו']);

    const admin = await adminHome();
    expect(admin.sections[0].unavailable.bannerIds).toEqual([ended.id, off.id, future.id]);
    expect(admin.sections[2].unavailable.bannerIds).toEqual([off.id, future.id]);
  });

  it('home survives missing references and the admin marks them', async () => {
    const sofas = await prisma.category.findUniqueOrThrow({ where: { slug: 'sofas' } });
    const product = (await site<ProductListResponse>('/api/products?pageSize=1')).items[0];
    // Rows that name things that are gone (as after a later deletion), written straight to the database.
    await prisma.homeSection.deleteMany();
    await prisma.homeSection.createMany({
      data: [
        { sortOrder: 0, kind: HomeSectionKind.HERO, config: { bannerIds: [999_991] } },
        { sortOrder: 1, kind: HomeSectionKind.CATEGORIES, config: { categoryIds: [999_992, 999_993] } },
        { sortOrder: 2, kind: HomeSectionKind.CATEGORIES, config: { categoryIds: [999_992, sofas.id] } },
        {
          sortOrder: 3,
          kind: HomeSectionKind.PRODUCTS,
          config: { source: { kind: 'category', id: 999_992 }, count: 4 },
        },
        { sortOrder: 4, kind: HomeSectionKind.PRODUCTS, config: { source: { kind: 'room', id: 999_994 }, count: 4 } },
        {
          sortOrder: 5,
          kind: HomeSectionKind.PRODUCTS,
          config: { source: { kind: 'promotion', id: 999_995 }, count: 4 },
        },
        {
          sortOrder: 6,
          kind: HomeSectionKind.PRODUCTS,
          config: { source: { kind: 'manual', productIds: [999_996, product.id] }, count: 4 },
        },
        { sortOrder: 7, kind: HomeSectionKind.BANNER_PAIR, config: { bannerIds: [999_991] } },
        // Unreadable settings are read leniently.
        { sortOrder: 8, kind: HomeSectionKind.PRODUCTS, config: { source: 'oops', count: 99 } },
      ],
    });
    await fresh();

    const view = await home();
    expect(kinds(view)).toEqual(['hero', 'categories', 'products']);
    expect(section(view, 'hero').banner).toBeNull();
    expect(section(view, 'categories').categories.map((c) => c.slug)).toEqual(['sofas']);
    expect(section(view, 'products').items.map((c) => c.id)).toEqual([product.id]);

    const admin = await adminHome();
    expect(admin.sections.map((s) => s.unavailable)).toEqual([
      { bannerIds: [999_991], categoryIds: [], productIds: [], source: false },
      { bannerIds: [], categoryIds: [999_992, 999_993], productIds: [], source: false },
      { bannerIds: [], categoryIds: [999_992], productIds: [], source: false },
      { bannerIds: [], categoryIds: [], productIds: [], source: true },
      { bannerIds: [], categoryIds: [], productIds: [], source: true },
      { bannerIds: [], categoryIds: [], productIds: [], source: true },
      { bannerIds: [], categoryIds: [], productIds: [999_996], source: false },
      { bannerIds: [999_991], categoryIds: [], productIds: [], source: false },
      { bannerIds: [], categoryIds: [], productIds: [], source: false },
    ]);
    // References a section already holds never block a save (the editor removes them when they choose).
    const input = asInput(admin).slice(0, 8);
    await save(input, admin.updatedAt).expect(200);
    // …but a new section cannot add them.
    const again = await adminHome();
    await save([...asInput(again), { ...input[1], id: undefined }], again.updatedAt).expect(400);
  });

  it('a banner a section uses cannot be deleted (409 naming the sections), hidden sections included', async () => {
    const used = await banner({ nameHe: 'ZZ בשימוש' });
    const h = await adminHome();
    const [hero, ...rest] = asInput(h);
    await save(
      [
        { ...hero, bannerIds: [used.id] } as AdminHomeSectionInput,
        { kind: 'banner_pair', bannerIds: [used.id], titleHe: 'באנרים למטה', visible: false },
        ...rest,
      ],
      h.updatedAt,
    ).expect(200);

    const res = await editor.delete(`/content/banners/${used.id}`).expect(409);
    expect(res.body).toMatchObject({ code: 'banner_in_use', sections: ['באנר ראשי', 'באנרים למטה'] });
    expect(await prisma.banner.count({ where: { id: used.id } })).toBe(1);

    const after = await adminHome();
    await save(
      asInput(after)
        .filter((s) => s.kind !== 'banner_pair')
        .map((s) => (s.kind === 'hero' ? ({ ...s, bannerIds: [] } as AdminHomeSectionInput) : s)),
      after.updatedAt,
    ).expect(200);
    await editor.delete(`/content/banners/${used.id}`).expect(204);
  });
});
