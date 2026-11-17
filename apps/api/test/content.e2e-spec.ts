import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import type {
  AdminAnnouncement,
  AdminAnnouncementInput,
  AdminFaqGroup,
  AdminFaqGroupInput,
  AdminInfoPage,
  AdminInfoPageInput,
  AdminSiteContent,
  AuditPage,
  FaqView,
  InfoPageView,
  OneTimeLink,
  SiteContentView,
  SitemapData,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import type { InfoPage, SiteContent } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

const SYSTEM_SLUGS = ['shipping', 'returns', 'warranty', 'terms', 'privacy'];
const HOSTILE =
  '<script>alert(1)</script><p onclick="steal()" style="color:red">שלום <strong>עולם</strong> ' +
  '<a href="javascript:alert(1)">קישור רע</a> <a href="//evil.example/x">רחוק</a> ' +
  '<a href="http://plain.example">לא מאובטח</a> <a href="https://good.example/a" target="_blank">טוב</a> ' +
  '<a href="tel:+97231234567">טלפון</a> <a href="/info/shipping">משלוחים</a>' +
  '<img src="x" onerror="alert(1)"></p><iframe src="https://evil.example"></iframe><style>p{}</style>';

/** Nothing executable or styled survives sanitizing. */
const expectClean = (html: string) => {
  for (const bad of [
    '<script',
    'alert',
    'onclick',
    'onerror',
    'style',
    '<img',
    '<iframe',
    'javascript:',
    'evil',
    'http:',
    'target',
  ])
    expect(html).not.toContain(bad);
};

// Runs against the e2e test database. Seeded rows (site details, system pages) are read first and written back in
// afterAll; announcements and FAQ groups this file creates start with "ZZ", its own pages with "zz-".
describe('Content API (e2e, NAV-04, SRV-04, ADM-06, Phase 8 §4–6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let service: AdminBrowser;
  let seededSite: SiteContent;
  let seededPages: InfoPage[];

  const get = (url: string) => request(app.getHttpServer()).get(url);
  const site = async () => (await get('/api/content/site').expect(200)).body as SiteContentView;
  const page = async (slug: string) => (await get(`/api/content/pages/${slug}`).expect(200)).body as InfoPageView;
  const faq = async () => (await get('/api/content/faq').expect(200)).body as FaqView;
  const sitemap = async () => (await get('/api/seo/sitemap').expect(200)).body as SitemapData;
  const audit = async (entityType: string) =>
    ((await owner.get(`/audit?entityType=${entityType}`).expect(200)).body as AuditPage).items;

  const pageInput = (over: Partial<AdminInfoPageInput> = {}): AdminInfoPageInput => ({
    slug: 'zz-about',
    titleHe: 'ZZ עלינו',
    bodyHtml: '<h2>מי אנחנו</h2><p>חנות רהיטים.</p>',
    metaDescriptionHe: 'ZZ תיאור',
    published: true,
    noindex: false,
    showInFooter: false,
    footerLabelHe: null,
    footerOrder: 0,
    ...over,
  });
  const announcementInput = (over: Partial<AdminAnnouncementInput> = {}): AdminAnnouncementInput => ({
    textHe: 'ZZ מבצע חורף',
    linkUrl: '/category/sofas',
    linkLabelHe: 'לפרטים',
    active: true,
    sortOrder: 0,
    startsAt: null,
    endsAt: null,
    ...over,
  });
  const faqInput = (over: Partial<AdminFaqGroupInput> = {}): AdminFaqGroupInput => ({
    titleHe: 'ZZ משלוחים',
    sortOrder: 0,
    published: true,
    items: [
      { questionHe: 'כמה זמן לוקח משלוח?', answerHtml: '<p>עד 14 ימי עסקים.</p>', published: true },
      { questionHe: 'שאלה מוסתרת', answerHtml: '<p>לא מוצגת.</p>', published: false },
    ],
    ...over,
  });
  const createPage = async (over: Partial<AdminInfoPageInput> = {}) =>
    (await editor.post('/content/pages', pageInput(over)).expect(201)).body as AdminInfoPage;
  const createAnnouncement = async (over: Partial<AdminAnnouncementInput> = {}) =>
    (await editor.post('/content/announcements', announcementInput(over)).expect(201)).body as AdminAnnouncement;
  const systemPage = async (slug: string) =>
    ((await editor.get('/content/pages').expect(200)).body as AdminInfoPage[]).find((p) => p.slug === slug)!;
  const pageBody = (p: AdminInfoPage, over: Partial<AdminInfoPageInput> = {}) => ({
    slug: p.slug,
    titleHe: p.titleHe,
    bodyHtml: p.bodyHtml,
    metaDescriptionHe: p.metaDescriptionHe,
    published: p.published,
    noindex: p.noindex,
    showInFooter: p.showInFooter,
    footerLabelHe: p.footerLabelHe,
    footerOrder: p.footerOrder,
    expectedUpdatedAt: p.updatedAt,
    ...over,
  });

  const cleanup = async () => {
    await prisma.announcement.deleteMany({ where: { textHe: { startsWith: 'ZZ' } } });
    await prisma.faqGroup.deleteMany({ where: { titleHe: { startsWith: 'ZZ' } } });
    await prisma.infoPage.deleteMany({ where: { slug: { startsWith: 'zz-' }, systemKey: null } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    await cleanup();
    seededSite = await prisma.siteContent.findUniqueOrThrow({ where: { id: 1 } });
    seededPages = await prisma.infoPage.findMany({ where: { systemKey: { not: null } } });
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
    const { id: _id, updatedAt: _u, ...site } = seededSite;
    await prisma.siteContent.update({ where: { id: 1 }, data: site });
    for (const { id, createdAt: _c, updatedAt: _u2, ...p } of seededPages)
      await prisma.infoPage.update({ where: { id }, data: p });
    await resetAdminData(prisma);
    await app.close();
  });

  it('needs content.manage: 403 for a user without it', async () => {
    await service.get('/content/site').expect(403);
    await service.put('/content/site', {}).expect(403);
    await service.get('/content/announcements').expect(403);
    await service.post('/content/announcements', announcementInput()).expect(403);
    await service.get('/content/pages').expect(403);
    await service.post('/content/pages', pageInput()).expect(403);
    await service.delete('/content/pages/1').expect(403);
    await service.get('/content/faq').expect(403);
    await service.post('/content/faq', faqInput()).expect(403);
    await editor.get('/content/site').expect(200);
  });

  describe('public reads', () => {
    it('GET /api/content/site has the details, no announcement and the footer pages in order', async () => {
      const view = await site();
      expect(view).toEqual({
        supportPhone: seededSite.supportPhone,
        supportEmail: seededSite.supportEmail,
        whatsapp: seededSite.whatsapp,
        shippingHtml: seededSite.shippingHtml,
        announcement: null,
        footerPages: [
          { slug: 'shipping', labelHe: 'משלוחים' },
          { slug: 'returns', labelHe: 'מדיניות החזרות' },
          { slug: 'warranty', labelHe: 'אחריות' },
          { slug: 'terms', labelHe: 'תקנון' },
          { slug: 'privacy', labelHe: 'פרטיות' },
        ],
      });
    });

    it('GET /api/content/pages/:slug gives a published page; unknown → 404 not_found', async () => {
      const terms = await page('terms');
      expect(terms).toMatchObject({ slug: 'terms', titleHe: 'תנאי שימוש', noindex: true });
      expect(terms.bodyHtml).toContain('<h2>');
      expect(terms.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(Object.keys(terms).sort()).toEqual(
        ['bodyHtml', 'metaDescriptionHe', 'noindex', 'slug', 'titleHe', 'updatedAt'].sort(),
      );
      const missing = await get('/api/content/pages/zz-nothing-here').expect(404);
      expect(missing.body.code).toBe('not_found');
    });

    it('an unpublished page is a 404 for the public, and shows once published', async () => {
      const draft = await createPage({ slug: 'zz-draft', published: false });
      expect((await get('/api/content/pages/zz-draft').expect(404)).body.code).toBe('not_found');
      await editor.put(`/content/pages/${draft.id}`, pageBody(draft, { published: true })).expect(200);
      expect((await page('zz-draft')).titleHe).toBe('ZZ עלינו');
    });

    it('GET /api/content/faq lists published groups and items in order', async () => {
      const second = (await editor.post('/content/faq', faqInput({ titleHe: 'ZZ החזרות', sortOrder: 2 })).expect(201))
        .body as AdminFaqGroup;
      await editor.post('/content/faq', faqInput({ titleHe: 'ZZ משלוחים', sortOrder: 1 })).expect(201);
      await editor.post('/content/faq', faqInput({ titleHe: 'ZZ מוסתרת', sortOrder: 0, published: false })).expect(201);
      expect(second.items.map((i) => i.sortOrder)).toEqual([0, 1]);
      const view = await faq();
      const mine = view.groups.filter((g) => g.titleHe.startsWith('ZZ'));
      expect(mine.map((g) => g.titleHe)).toEqual(['ZZ משלוחים', 'ZZ החזרות']);
      expect(mine[0]).toEqual({
        titleHe: 'ZZ משלוחים',
        items: [{ questionHe: 'כמה זמן לוקח משלוח?', answerHtml: '<p>עד 14 ימי עסקים.</p>' }],
      });
    });
  });

  describe('info pages (admin)', () => {
    it('hostile body is sanitized (page body, FAQ answer, shipping text)', async () => {
      const created = await createPage({ slug: 'zz-hostile', bodyHtml: HOSTILE });
      expectClean(created.bodyHtml);
      expect(created.bodyHtml).toContain('<strong>עולם</strong>');
      expect(created.bodyHtml).toContain('<a href="https://good.example/a" rel="noopener">טוב</a>');
      expect(created.bodyHtml).toContain('<a href="tel:+97231234567">טלפון</a>');
      expect(created.bodyHtml).toContain('<a href="/info/shipping">משלוחים</a>');
      const stored = await prisma.infoPage.findUniqueOrThrow({ where: { id: created.id } });
      expectClean(stored.bodyHtml);
      expectClean((await page('zz-hostile')).bodyHtml);

      const group = (
        await editor
          .post(
            '/content/faq',
            faqInput({
              titleHe: 'ZZ עוין',
              items: [{ questionHe: 'שאלה', answerHtml: `<h2>כותרת</h2>${HOSTILE}`, published: true }],
            }),
          )
          .expect(201)
      ).body as AdminFaqGroup;
      expectClean(group.items[0].answerHtml);
      // Inline mode: no headings.
      expect(group.items[0].answerHtml).not.toContain('<h2');
      expect(group.items[0].answerHtml).toContain('<p>כותרת</p>');

      const current = (await editor.get('/content/site').expect(200)).body as AdminSiteContent;
      const saved = (
        await editor
          .put('/content/site', { ...current, shippingHtml: HOSTILE, expectedUpdatedAt: current.updatedAt })
          .expect(200)
      ).body as AdminSiteContent;
      expectClean(saved.shippingHtml);
      expectClean((await site()).shippingHtml);
    });

    it('refuses a body with no words after sanitizing', async () => {
      const res = await editor.post('/content/pages', pageInput({ slug: 'zz-empty', bodyHtml: '<script>x</script>' }));
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid', field: 'bodyHtml' });
    });

    it('stale save is refused (409 conflict) and the first save is kept', async () => {
      const created = await createPage({ slug: 'zz-race' });
      const first = (
        await editor.put(`/content/pages/${created.id}`, pageBody(created, { titleHe: 'ZZ ראשון' })).expect(200)
      ).body as AdminInfoPage;
      expect(first.updatedAt).not.toBe(created.updatedAt);
      const stale = await owner.put(`/content/pages/${created.id}`, pageBody(created, { titleHe: 'ZZ שני' }));
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('conflict');
      expect((await page('zz-race')).titleHe).toBe('ZZ ראשון');
      // An update without expectedUpdatedAt is refused.
      const { expectedUpdatedAt: _e, ...noStamp } = pageBody(first);
      expect((await editor.put(`/content/pages/${created.id}`, noStamp).expect(400)).body.field).toBe(
        'expectedUpdatedAt',
      );
    });

    it('system pages: no delete, fixed slug, always published; a text save clears interim', async () => {
      const terms = await systemPage('terms');
      expect(terms.systemKey).toBe('terms');
      const del = await editor.delete(`/content/pages/${terms.id}`).expect(409);
      expect(del.body.code).toBe('system_page');
      const slug = await editor.put(`/content/pages/${terms.id}`, pageBody(terms, { slug: 'zz-terms' })).expect(400);
      expect(slug.body).toMatchObject({ code: 'system_page', field: 'slug' });
      const unpublish = await editor
        .put(`/content/pages/${terms.id}`, pageBody(terms, { published: false }))
        .expect(400);
      expect(unpublish.body).toMatchObject({ code: 'system_page', field: 'published' });
      expect(await prisma.infoPage.findUnique({ where: { slug: 'terms' } })).not.toBeNull();

      const saved = (
        await editor
          .put(`/content/pages/${terms.id}`, pageBody(terms, { bodyHtml: '<p>נוסח חדש.</p>', noindex: false }))
          .expect(200)
      ).body as AdminInfoPage;
      expect(saved).toMatchObject({ interim: false, systemKey: 'terms', slug: 'terms', published: true });
      expect((await page('terms')).bodyHtml).toBe('<p>נוסח חדש.</p>');
    });

    it('slug_taken on create and on rename; a bad slug is invalid', async () => {
      await createPage({ slug: 'zz-taken' });
      const again = await editor.post('/content/pages', pageInput({ slug: 'zz-taken' })).expect(409);
      expect(again.body).toMatchObject({ code: 'slug_taken', field: 'slug' });
      const other = await createPage({ slug: 'zz-other' });
      const rename = await editor.put(`/content/pages/${other.id}`, pageBody(other, { slug: 'terms' })).expect(409);
      expect(rename.body).toMatchObject({ code: 'slug_taken', field: 'slug' });
      for (const slug of ['ZZ-Upper', 'zz bad', 'zz--double', '-zz', 'zz/x', ''])
        expect((await editor.post('/content/pages', pageInput({ slug })).expect(400)).body).toMatchObject({
          code: 'invalid',
          field: 'slug',
        });
    });

    it('deletes a page (audited) and writes an audit row on create and update', async () => {
      const created = await createPage({ slug: 'zz-gone', titleHe: 'ZZ למחיקה' });
      await editor.put(`/content/pages/${created.id}`, pageBody(created, { titleHe: 'ZZ למחיקה 2' })).expect(200);
      await editor.delete(`/content/pages/${created.id}`).expect(204);
      await get('/api/content/pages/zz-gone').expect(404);
      await editor.delete(`/content/pages/${created.id}`).expect(404);
      const entries = (await audit('info_page')).filter((e) => e.entityId === String(created.id));
      expect(entries.map((e) => e.action).sort()).toEqual(
        ['content.page.create', 'content.page.delete', 'content.page.update'].sort(),
      );
      const update = entries.find((e) => e.action === 'content.page.update')!;
      expect(update.before).toMatchObject({ כותרת: 'ZZ למחיקה' });
      expect(update.after).toMatchObject({ כותרת: 'ZZ למחיקה 2' });
      expect(entries.find((e) => e.action === 'content.page.delete')?.entityLabel).toBe('ZZ למחיקה 2');
    });
  });

  describe('announcements', () => {
    it('invalid_link for unsafe link fields', async () => {
      for (const linkUrl of [
        'javascript:alert(1)',
        'http://plain.example',
        '//evil.example',
        'data:text/html,x',
        'sofas',
      ])
        expect((await editor.post('/content/announcements', announcementInput({ linkUrl })).expect(400)).body).toEqual(
          expect.objectContaining({ code: 'invalid_link', field: 'linkUrl' }),
        );
      for (const linkUrl of ['/info/shipping', 'https://example.co.il/x', 'tel:+97231234567', 'mailto:a@b.co'])
        await editor.post('/content/announcements', announcementInput({ textHe: 'ZZ קישור', linkUrl })).expect(201);
      await prisma.announcement.deleteMany({ where: { textHe: 'ZZ קישור' } });
    });

    it('bumps the version only when the text or the link changes, and the public bar follows', async () => {
      const created = await createAnnouncement();
      expect(created.version).toBe(1);
      expect((await site()).announcement).toEqual({
        id: created.id,
        version: 1,
        textHe: 'ZZ מבצע חורף',
        linkUrl: '/category/sofas',
        linkLabelHe: 'לפרטים',
      });
      const put = async (a: AdminAnnouncement, over: Partial<AdminAnnouncementInput>) =>
        (
          await editor
            .put(`/content/announcements/${a.id}`, {
              ...announcementInput(),
              textHe: a.textHe,
              linkUrl: a.linkUrl,
              linkLabelHe: a.linkLabelHe,
              sortOrder: a.sortOrder,
              startsAt: a.startsAt,
              endsAt: a.endsAt,
              ...over,
              expectedUpdatedAt: a.updatedAt,
            })
            .expect(200)
        ).body as AdminAnnouncement;
      const dates = await put(created, { sortOrder: 3, endsAt: '2099-12-31T21:59:59.999Z' });
      expect(dates.version).toBe(1);
      const text = await put(dates, { textHe: 'ZZ מבצע חורף מורחב' });
      expect(text.version).toBe(2);
      const linked = await put(text, { linkUrl: '/category/armchairs' });
      expect(linked.version).toBe(3);
      const label = await put(linked, { linkLabelHe: 'לכל המבצעים' });
      expect(label.version).toBe(4);
      expect((await site()).announcement).toMatchObject({ id: created.id, version: 4, textHe: 'ZZ מבצע חורף מורחב' });
      const stale = await editor.put(`/content/announcements/${created.id}`, {
        ...announcementInput(),
        expectedUpdatedAt: created.updatedAt,
      });
      expect(stale.status).toBe(409);
      expect((await audit('announcement')).map((e) => e.action)).toEqual(
        expect.arrayContaining(['content.announcement.create', 'content.announcement.update']),
      );
      await editor.delete(`/content/announcements/${created.id}`).expect(204);
      expect((await site()).announcement).toBeNull();
    });

    it('shows one live announcement: lowest order, dates included, ended and future ones hidden', async () => {
      const day = 24 * 60 * 60_000;
      await createAnnouncement({ textHe: 'ZZ הסתיים', sortOrder: 0, endsAt: new Date(Date.now() - day).toISOString() });
      await createAnnouncement({
        textHe: 'ZZ עתידי',
        sortOrder: 0,
        startsAt: new Date(Date.now() + day).toISOString(),
      });
      await createAnnouncement({ textHe: 'ZZ כבוי', sortOrder: 0, active: false });
      await createAnnouncement({ textHe: 'ZZ שני', sortOrder: 2 });
      const first = await createAnnouncement({ textHe: 'ZZ ראשון', sortOrder: 1 });
      expect((await site()).announcement?.id).toBe(first.id);
      const list = (await editor.get('/content/announcements').expect(200)).body as AdminAnnouncement[];
      expect(list.filter((a) => a.textHe.startsWith('ZZ'))).toHaveLength(5);
      await prisma.announcement.deleteMany({ where: { textHe: { startsWith: 'ZZ' } } });
    });

    it('refuses an end before the start and a link label without a link', async () => {
      const ends = await editor
        .post(
          '/content/announcements',
          announcementInput({ startsAt: '2026-12-10T22:00:00.000Z', endsAt: '2026-12-01T21:59:59.999Z' }),
        )
        .expect(400);
      expect(ends.body).toMatchObject({ code: 'invalid', field: 'endsAt' });
      const label = await editor.post('/content/announcements', announcementInput({ linkUrl: null })).expect(400);
      expect(label.body).toMatchObject({ code: 'invalid', field: 'linkLabelHe' });
      const long = await editor.post('/content/announcements', announcementInput({ textHe: 'ZZ' + 'א'.repeat(119) }));
      expect(long.body).toMatchObject({ code: 'invalid', field: 'textHe' });
    });
  });

  describe('site details and FAQ (admin)', () => {
    it('saves the site details, clears interim, and the public answer changes right away (cache cleared)', async () => {
      await site(); // warm the cache
      const current = (await editor.get('/content/site').expect(200)).body as AdminSiteContent;
      const saved = (
        await editor
          .put('/content/site', {
            supportPhone: '03-1234567',
            supportEmail: 'help@example.test',
            whatsapp: '972501234567',
            shippingHtml: '<p>משלוח חינם.</p>',
            expectedUpdatedAt: current.updatedAt,
          })
          .expect(200)
      ).body as AdminSiteContent;
      expect(saved).toMatchObject({ supportPhone: '03-1234567', interim: false });
      expect(await site()).toMatchObject({
        supportPhone: '03-1234567',
        supportEmail: 'help@example.test',
        whatsapp: '972501234567',
        shippingHtml: '<p>משלוח חינם.</p>',
      });
      const stale = await editor.put('/content/site', {
        supportPhone: '03-7654321',
        supportEmail: 'help@example.test',
        whatsapp: '972501234567',
        shippingHtml: '<p>x</p>',
        expectedUpdatedAt: current.updatedAt,
      });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe('conflict');
      for (const [field, value] of [
        ['supportEmail', 'not-an-email'],
        ['whatsapp', '+972501234567'],
        ['supportPhone', 'call us'],
      ])
        expect(
          (
            await editor
              .put('/content/site', { ...saved, [field]: value, expectedUpdatedAt: saved.updatedAt })
              .expect(400)
          ).body,
        ).toMatchObject({ code: 'invalid', field });
      expect((await audit('site_content')).map((e) => e.action)).toContain('content.site.update');
    });

    it('saves a FAQ group with its items in one save (add, edit, reorder, remove) and deletes it', async () => {
      const group = (await editor.post('/content/faq', faqInput({ titleHe: 'ZZ קבוצה' })).expect(201))
        .body as AdminFaqGroup;
      const [a, b] = group.items;
      const saved = (
        await editor
          .put(`/content/faq/${group.id}`, {
            titleHe: 'ZZ קבוצה',
            sortOrder: 0,
            published: true,
            items: [
              { id: b.id, questionHe: b.questionHe, answerHtml: b.answerHtml, published: true },
              { questionHe: 'שאלה חדשה', answerHtml: '<p>תשובה חדשה.</p>', published: true },
            ],
            expectedUpdatedAt: group.updatedAt,
          })
          .expect(200)
      ).body as AdminFaqGroup;
      expect(saved.items.map((i) => i.questionHe)).toEqual(['שאלה מוסתרת', 'שאלה חדשה']);
      expect(saved.items[0].id).toBe(b.id);
      expect(saved.items.map((i) => i.sortOrder)).toEqual([0, 1]);
      expect(await prisma.faqItem.findUnique({ where: { id: a.id } })).toBeNull();
      expect((await faq()).groups.find((g) => g.titleHe === 'ZZ קבוצה')?.items.map((i) => i.questionHe)).toEqual([
        'שאלה מוסתרת',
        'שאלה חדשה',
      ]);

      // An item id of another group is refused.
      const other = (await editor.post('/content/faq', faqInput({ titleHe: 'ZZ אחרת' })).expect(201))
        .body as AdminFaqGroup;
      const foreign = await editor
        .put(`/content/faq/${group.id}`, {
          ...faqInput({ titleHe: 'ZZ קבוצה' }),
          items: [{ id: other.items[0].id, questionHe: 'ש', answerHtml: '<p>ת</p>', published: true }],
          expectedUpdatedAt: saved.updatedAt,
        })
        .expect(400);
      expect(foreign.body).toMatchObject({ code: 'invalid', field: 'items.0.id' });
      // A stale save is refused.
      expect(
        (await editor.put(`/content/faq/${group.id}`, { ...faqInput(), expectedUpdatedAt: group.updatedAt })).body.code,
      ).toBe('conflict');

      await editor.delete(`/content/faq/${group.id}`).expect(204);
      expect((await faq()).groups.find((g) => g.titleHe === 'ZZ קבוצה')).toBeUndefined();
      expect(await prisma.faqItem.count({ where: { groupId: group.id } })).toBe(0);
      expect((await audit('faq_group')).map((e) => e.action)).toEqual(
        expect.arrayContaining(['content.faq.create', 'content.faq.update', 'content.faq.delete']),
      );
    });
  });

  it('sitemap lists only published pages that are not noindex', async () => {
    await createPage({ slug: 'zz-indexed' });
    await createPage({ slug: 'zz-noindex', noindex: true });
    await createPage({ slug: 'zz-unpublished', published: false });
    const { infoPages } = await sitemap();
    const slugs = infoPages.map((p) => p.slug);
    expect(slugs).toContain('zz-indexed');
    expect(slugs).not.toContain('zz-noindex');
    expect(slugs).not.toContain('zz-unpublished');
    // Seeded system pages are noindex while interim; terms was saved above with noindex off.
    expect(slugs).toContain('terms');
    expect(slugs).not.toContain('privacy');
    expect(infoPages.find((p) => p.slug === 'zz-indexed')?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(SYSTEM_SLUGS.every((s) => seededPages.some((p) => p.slug === s))).toBe(true);
  });
});
