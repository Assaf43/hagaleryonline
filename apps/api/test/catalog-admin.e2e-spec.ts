import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import ExcelJS from 'exceljs';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type {
  AdminProduct,
  AdminProductInput,
  AdminProductPage,
  AdminVariant,
  AuditPage,
  CatalogStructure,
  ImportReport,
  OneTimeLink,
  ProductListResponse,
  TotpSetup,
} from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { AdminUsersService } from './../src/auth/admin-users.service.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData } from './admin-session.js';

const ORIGIN = 'http://localhost:4300';
const SUPER = { email: 'catalog-owner@example.test', password: 'olive sofa sunset window' };
const EDITOR = { email: 'catalog-editor@example.test', password: 'terracotta lamp quiet river' };

/** Catalog management end to end (Phase 2b), on the e2e test database. Cleans up after itself. */
describe('Catalog admin (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: Browser;
  let editor: Browser;
  let structure: CatalogStructure;

  const browser = () => {
    const agent = request.agent(app.getHttpServer());
    const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string, body?: object) =>
      agent[method](`/api/admin${url}`).set('Origin', ORIGIN).send(body);
    return {
      agent,
      get: call('get'),
      post: call('post'),
      patch: call('patch'),
      put: call('put'),
      delete: call('delete'),
    };
  };
  type Browser = ReturnType<typeof browser>;
  const storefront = (url: string) => request(app.getHttpServer()).get(`/api${url}`);

  async function signIn(user: { email: string; password: string }, link: OneTimeLink): Promise<Browser> {
    await browser()
      .post(`/links/${link.url.split('/').pop()}`, { password: user.password })
      .expect(204);
    const b = browser();
    await b.post('/auth/login', { email: user.email, password: user.password }).expect(200);
    const setup = (await b.post('/auth/2fa/setup').expect(200)).body as TotpSetup;
    const code = new TOTP({ secret: Secret.fromBase32(setup.secret) }).generate();
    await b.post('/auth/2fa/enable', { code }).expect(200);
    return b;
  }

  const categoryId = (slug: string) => structure.categories.find((c) => c.slug === slug)!.id;
  const variant = (sku: string, extra: Partial<AdminVariant> = {}): AdminVariant => ({
    sku,
    price: 389_000,
    compareAtPrice: null,
    stock: 3,
    fulfillment: 'in_stock',
    leadTimeDays: 14,
    productionDays: null,
    expectedAt: null,
    active: true,
    widthCm: 220,
    depthCm: 95,
    heightCm: 85,
    weightKg: null,
    seatHeightCm: 45,
    seatDepthCm: 58,
    chaiseWidthCm: null,
    chaiseDepthCm: null,
    options: { color: 'beige' },
    ...extra,
  });
  const newProduct = (extra: Partial<AdminProductInput> = {}): AdminProductInput => ({
    slug: 'zzbreeze-three-seater-sofa',
    modelName: 'ZZBREEZE',
    nameHe: 'ספה תלת-מושבית בריזה',
    descriptionHe: '<p>ספה <strong>קלילה</strong> לסלון קטן</p>',
    categoryId: categoryId('three-seater-sofas'),
    roomIds: [structure.rooms[0].id],
    attributes: { style: ['modern'] },
    countryOfOrigin: null,
    warrantyMonths: 12,
    careHe: null,
    requiresAssembly: false,
    active: false,
    sortOrder: 0,
    variants: [variant('ZZBREEZE-220-BG'), variant('ZZBREEZE-220-GR', { options: { color: 'gray' } })],
    ...extra,
  });
  const forSave = (p: AdminProduct, changes: Partial<AdminProductInput> = {}): AdminProductInput => {
    const { id: _id, images: _i, createdAt: _c, updatedAt, relations, ...rest } = p;
    const ids = (picks: { id: number }[]) => picks.map((r) => r.id);
    return {
      ...rest,
      relations: { goesWith: ids(relations.goesWith), similar: ids(relations.similar) },
      expectedUpdatedAt: updatedAt,
      ...changes,
    };
  };
  const findBySearch = async (q: string) =>
    (
      (await storefront(`/products?q=${encodeURIComponent(q)}&pageSize=60`).expect(200)).body as ProductListResponse
    ).items.map((i) => i.modelName);

  let productId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);

    owner = await signIn(SUPER, await app.get(AdminUsersService).createSuperAdmin(SUPER.email, 'בעלת העסק'));
    const created = await owner
      .post('/users', { email: EDITOR.email, name: 'עורך תוכן', template: 'content_editor' })
      .expect(201);
    editor = await signIn(EDITOR, created.body.invite as OneTimeLink);
    structure = (await owner.get('/catalog/structure').expect(200)).body as CatalogStructure;
  });

  afterAll(async () => {
    // Leave the seed catalog as the other e2e files expect it (products first: they use the zz- values).
    await resetAdminData(prisma);
    await prisma.category.deleteMany({ where: { slug: { startsWith: 'zz-' } } });
    await prisma.attributeValue.deleteMany({ where: { code: { startsWith: 'zz-' } } });
    await prisma.searchSynonym.deleteMany({ where: { terms: { has: 'zzpillowy' } } });
    await app.close();
  });

  it('creates a hidden product that the site does not show yet', async () => {
    const created = (await editor.post('/catalog/products', newProduct()).expect(201)).body as AdminProduct;
    productId = created.id;
    expect(created).toMatchObject({ modelName: 'ZZBREEZE', active: false });
    expect(created.variants.map((v) => v.sku)).toEqual(['ZZBREEZE-220-BG', 'ZZBREEZE-220-GR']);
    await storefront('/products/zzbreeze-three-seater-sofa').expect(404);
  });

  it('shows the product on the site as soon as it is activated, and finds it by name and SKU', async () => {
    const current = (await editor.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    // Not without a photo (decision 62); uploads have their own e2e file, a placeholder row is enough here.
    const noPhoto = await editor.put(`/catalog/products/${productId}`, forSave(current, { active: true })).expect(400);
    expect(noPhoto.body).toMatchObject({ code: 'incomplete', reasons: ['no_images'] });
    await prisma.image.create({ data: { productId, url: '/images/placeholder/sofa.svg', altHe: 'ספה' } });
    await editor.put(`/catalog/products/${productId}`, forSave(current, { active: true })).expect(200);
    const page = (await storefront('/products/zzbreeze-three-seater-sofa').expect(200)).body;
    expect(page.descriptionHe).toBe('<p>ספה <strong>קלילה</strong> לסלון קטן</p>');
    expect(await findBySearch('zzbreeze')).toEqual(['ZZBREEZE']);
    expect(await findBySearch('בריזה')).toContain('ZZBREEZE');
    expect(await findBySearch('ZZBREEZE-220-GR')).toEqual(['ZZBREEZE']);
  });

  it('refuses a stale save instead of overwriting someone else’s change', async () => {
    const opened = (await editor.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    await owner.put(`/catalog/products/${productId}`, forSave(opened, { nameHe: 'ספה בריזה' })).expect(200);
    const stale = await editor.put(`/catalog/products/${productId}`, forSave(opened, { sortOrder: 5 })).expect(409);
    expect(stale.body.code).toBe('conflict');
  });

  it('logs a price change with the SKU, before and after (decision 54)', async () => {
    const current = (await editor.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    const variants = current.variants.map((v, i) => (i === 0 ? { ...v, price: 369_000 } : v));
    await editor.put(`/catalog/products/${productId}`, forSave(current, { variants })).expect(200);

    const audit = (await owner.get('/audit?entityType=variant').expect(200)).body as AuditPage;
    expect(audit.items[0]).toMatchObject({
      action: 'variant.update',
      entityLabel: 'ZZBREEZE-220-BG',
      actor: { name: 'עורך תוכן' },
      before: { sku: 'ZZBREEZE-220-BG', price: 389_000 },
      after: { sku: 'ZZBREEZE-220-BG', price: 369_000 },
    });
    const productAudit = (await owner.get(`/audit?entityType=product&entityId=${productId}`).expect(200))
      .body as AuditPage;
    expect(productAudit.items.map((e) => e.action)).toEqual(['product.update', 'product.update', 'product.create']);
  });

  it('rejects a SKU another product already uses, and a duplicate option and size combination', async () => {
    const seedSku = (await prisma.variant.findFirst({ orderBy: { id: 'asc' } }))!.sku;
    const current = (await editor.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    const taken = await editor
      .put(
        `/catalog/products/${productId}`,
        forSave(current, { variants: [...current.variants, variant(seedSku, { options: {} })] }),
      )
      .expect(409);
    expect(taken.body).toMatchObject({ code: 'duplicate', field: 'sku', value: seedSku });

    const twin = await editor
      .put(
        `/catalog/products/${productId}`,
        forSave(current, { variants: [...current.variants, variant('ZZBREEZE-220-BG2')] }),
      )
      .expect(400);
    expect(twin.body).toMatchObject({ code: 'invalid', field: 'variants.2.options' });
    // The same color in another width is a different variant.
    await editor
      .put(
        `/catalog/products/${productId}`,
        forSave(current, { variants: [...current.variants, variant('ZZBREEZE-260-BG', { widthCm: 260 })] }),
      )
      .expect(200);
  });

  it('does not activate a product without an active variant or a photo', async () => {
    const draft = newProduct({
      slug: 'zzempty-sofa',
      modelName: 'ZZEMPTY',
      active: true,
      variants: [variant('ZZEMPTY-1', { active: false })],
    });
    const res = await editor.post('/catalog/products', draft).expect(400);
    expect(res.body).toMatchObject({ code: 'incomplete', reasons: ['no_variants', 'no_images'] });
  });

  it('keeps structure and permanent deletion away from a content editor', async () => {
    await editor.post('/catalog/synonyms', { terms: ['zzpillowy', 'כרית'] }).expect(403);
    await editor.delete(`/catalog/products/${productId}`).expect(403);
    const list = (await editor.get('/catalog/products?q=zzbreeze').expect(200)).body as AdminProductPage;
    expect(list.items).toEqual([expect.objectContaining({ id: productId, priceFrom: 369_000, totalStock: 9 })]);
  });

  it('renaming a color relabels the product in search; a used value cannot be deleted', async () => {
    const color = structure.attributes.find((a) => a.code === 'color')!;
    await owner.post(`/catalog/attributes/${color.id}/values`, { code: 'zz-sage', labelHe: 'Zzsage', sortOrder: 99 });
    const sage = ((await owner.get('/catalog/structure').expect(200)).body as CatalogStructure).attributes
      .find((a) => a.code === 'color')!
      .values.find((v) => v.code === 'zz-sage')!;
    expect(sage.usageCount).toBe(0);

    const current = (await editor.get(`/catalog/products/${productId}`).expect(200)).body as AdminProduct;
    const variants = [...current.variants, variant('ZZBREEZE-220-SG', { options: { color: 'zz-sage' } })];
    await editor.put(`/catalog/products/${productId}`, forSave(current, { variants })).expect(200);
    expect(await findBySearch('zzsage')).toEqual(['ZZBREEZE']);

    await owner
      .patch(`/catalog/attributes/${color.id}/values/${sage.id}`, {
        code: 'zz-sage',
        labelHe: 'Zzmint',
        sortOrder: 99,
      })
      .expect(204);
    expect(await findBySearch('zzmint')).toEqual(['ZZBREEZE']);
    expect(await findBySearch('zzsage')).toEqual([]);
    const used = await owner.delete(`/catalog/attributes/${color.id}/values/${sage.id}`).expect(409);
    expect(used.body.code).toBe('in_use');
  });

  it('a new synonym group widens search right away', async () => {
    expect(await findBySearch('zzpillowy')).toEqual([]);
    await owner.post('/catalog/synonyms', { terms: ['zzpillowy', 'zzbreeze'] }).expect(201);
    expect(await findBySearch('zzpillowy')).toEqual(['ZZBREEZE']);
  });

  it('adds a category with its filters, and refuses to put a category under itself', async () => {
    const color = 'color';
    await owner
      .post('/catalog/categories', {
        slug: 'zz-benches',
        nameHe: 'ספסלים',
        parentId: null,
        sortOrder: 50,
        active: true,
        attributeCodes: [color, 'material'],
      })
      .expect(204);
    const added = ((await owner.get('/catalog/structure').expect(200)).body as CatalogStructure).categories.find(
      (c) => c.slug === 'zz-benches',
    )!;
    expect(added.attributeCodes).toEqual(['color', 'material']);

    const sofas = categoryId('sofas');
    const res = await owner
      .patch(`/catalog/categories/${sofas}`, {
        slug: 'sofas',
        nameHe: 'ספות',
        parentId: categoryId('corner-sofas'),
        sortOrder: 0,
        active: true,
        attributeCodes: [],
      })
      .expect(400);
    expect(res.body).toMatchObject({ code: 'invalid', field: 'parentId' });
  });

  it('re-saves an existing sofa with all its sizes and options unchanged, logging nothing', async () => {
    const alba = (await prisma.product.findUnique({ where: { modelName: 'ALBA' } }))!;
    const before = (await editor.get(`/catalog/products/${alba.id}`).expect(200)).body as AdminProduct;
    const after = (await editor.put(`/catalog/products/${alba.id}`, forSave(before)).expect(200)).body as AdminProduct;
    expect(after.variants).toEqual(before.variants);
    const audit = (await owner.get(`/audit?entityType=product&entityId=${alba.id}`).expect(200)).body as AuditPage;
    expect(audit.total).toBe(0);
  });

  describe('product relations', () => {
    const ids: Record<'a' | 'b' | 'c', number> = { a: 0, b: 0, c: 0 };
    const load = async (id: number) => (await editor.get(`/catalog/products/${id}`).expect(200)).body as AdminProduct;
    const goesWith = async (id: number) => (await load(id)).relations.goesWith.map((r) => r.id);
    const save = async (id: number, changes: Partial<AdminProductInput>, status = 200) =>
      editor.put(`/catalog/products/${id}`, forSave(await load(id), changes)).expect(status);
    const links = (goesWithIds: number[], similar: number[] = []) => ({
      relations: { goesWith: goesWithIds, similar },
    });

    beforeAll(async () => {
      for (const key of ['a', 'b', 'c'] as const) {
        const model = `ZZREL${key.toUpperCase()}`;
        const created = await editor
          .post(
            '/catalog/products',
            newProduct({ slug: `zzrel-${key}`, modelName: model, variants: [variant(`${model}-1`)] }),
          )
          .expect(201);
        ids[key] = (created.body as AdminProduct).id;
      }
    });

    it('links both ways', async () => {
      const saved = (await save(ids.a, links([ids.b]))).body as AdminProduct;
      expect(saved.relations.goesWith).toEqual([
        { id: ids.b, modelName: 'ZZRELB', nameHe: 'ספה תלת-מושבית בריזה', active: false, thumbnailUrl: null },
      ]);
      expect(saved).toMatchObject({ goesWithAutofill: true, similarAutofill: true });
      expect(await goesWith(ids.b)).toEqual([ids.a]);
      expect((await load(ids.b)).relations.similar).toEqual([]);
    });

    it("keeps each side's order", async () => {
      await save(ids.a, links([ids.b, ids.c]));
      expect(await goesWith(ids.b)).toEqual([ids.a]);
      expect(await goesWith(ids.c)).toEqual([ids.a]);
      await save(ids.a, links([ids.c, ids.b]));
      expect(await goesWith(ids.a)).toEqual([ids.c, ids.b]);
      expect(await goesWith(ids.b)).toEqual([ids.a]);
      expect(await goesWith(ids.c)).toEqual([ids.a]);
      // A new link on the other side goes after that side's existing picks.
      await save(ids.b, links([ids.a, ids.c]));
      expect(await goesWith(ids.c)).toEqual([ids.a, ids.b]);
    });

    it('removing on either side removes both', async () => {
      await save(ids.b, links([]));
      expect(await goesWith(ids.a)).toEqual([ids.c]);
      expect(await goesWith(ids.c)).toEqual([ids.a]);
      expect(await prisma.productRelation.count({ where: { OR: [{ productId: ids.b }, { relatedId: ids.b }] } })).toBe(
        0,
      );
    });

    it('bumps the other side', async () => {
      const openedB = await load(ids.b);
      await save(ids.a, links([ids.c, ids.b]));
      const stale = await editor.put(`/catalog/products/${ids.b}`, forSave(openedB, { sortOrder: 3 })).expect(409);
      expect(stale.body.code).toBe('conflict');
      // A save that changes no link leaves the other side alone.
      const openedC = await load(ids.c);
      await save(ids.a, { careHe: 'לנגב ביובש' });
      await editor.put(`/catalog/products/${ids.c}`, forSave(openedC)).expect(200);
    });

    it('rejects self, duplicates, unknown ids', async () => {
      const self = await save(ids.a, links([ids.a]), 400);
      expect(self.body).toMatchObject({ code: 'invalid', field: 'relations.goesWith' });
      const twice = await save(ids.a, links([], [ids.b, ids.b]), 400);
      expect(twice.body).toMatchObject({ code: 'invalid', field: 'relations.similar' });
      const unknown = await save(ids.a, links([999_999]), 400);
      expect(unknown.body).toMatchObject({ code: 'invalid', field: 'relations.goesWith' });
      expect(await goesWith(ids.a)).toEqual([ids.c, ids.b]);
    });

    it('records added and removed links and the flags in the audit log', async () => {
      await save(ids.a, { ...links([ids.b], [ids.c]), similarAutofill: false });
      const saved = await load(ids.a);
      expect(saved).toMatchObject({ goesWithAutofill: true, similarAutofill: false });
      expect(saved.relations.similar.map((r) => r.id)).toEqual([ids.c]);
      const audit = (await owner.get(`/audit?entityType=product&entityId=${ids.a}`).expect(200)).body as AuditPage;
      expect(audit.items[0]).toMatchObject({
        action: 'product.update',
        before: { goesWith: [ids.c, ids.b], similar: [], similarAutofill: true },
        after: { goesWith: [ids.b], similar: [ids.c], similarAutofill: false },
      });
    });

    it('input without relations leaves them unchanged', async () => {
      const {
        relations: _r,
        goesWithAutofill: _g,
        similarAutofill: _s,
        ...withoutRelations
      } = forSave(await load(ids.a), { nameHe: 'ספה בלי קשרים' });
      await editor.put(`/catalog/products/${ids.a}`, withoutRelations).expect(200);
      const after = await load(ids.a);
      expect(after.relations.goesWith.map((r) => r.id)).toEqual([ids.b]);
      expect(after.relations.similar.map((r) => r.id)).toEqual([ids.c]);
      expect(after.similarAutofill).toBe(false);

      // Same through an Excel import of A (relations are not in the file).
      const exported = (
        await editor.agent
          .get('/api/admin/catalog/excel/export')
          .buffer(true)
          .parse((res, done) => {
            const chunks: Buffer[] = [];
            res.on('data', (c: Buffer) => chunks.push(c));
            res.on('end', () => done(null, Buffer.concat(chunks)));
          })
          .expect(200)
      ).body as Buffer;
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(exported as unknown as ArrayBuffer);
      const ws = wb.getWorksheet('מוצרים')!;
      const headers = new Map<string, number>();
      ws.getRow(1).eachCell((cell, col) => headers.set(cell.text.replace(' *', ''), col));
      let changed = false;
      for (let n = 2; n <= ws.rowCount; n++) {
        if (ws.getRow(n).getCell(headers.get('מק"ט')!).value === 'ZZRELA-1') {
          ws.getRow(n).getCell(headers.get('מחיר (₪)')!).value = 3990;
          changed = true;
        }
      }
      expect(changed).toBe(true);
      const report = (
        await editor.agent
          .post('/api/admin/catalog/excel/import')
          .set('Origin', ORIGIN)
          .attach('file', Buffer.from(await wb.xlsx.writeBuffer()), 'catalog.xlsx')
          .expect(200)
      ).body as ImportReport;
      expect(report).toMatchObject({ applied: true, errors: [], summary: { productsUpdated: 1 } });
      const imported = await load(ids.a);
      expect(imported.variants[0].price).toBe(399_000);
      expect(imported.relations.goesWith.map((r) => r.id)).toEqual([ids.b]);
      expect(imported.relations.similar.map((r) => r.id)).toEqual([ids.c]);
      expect(imported.similarAutofill).toBe(false);
    });

    it('hidden pick still listed in admin', async () => {
      await prisma.image.create({ data: { productId: ids.b, url: '/images/placeholder/sofa.svg', altHe: 'ספה' } });
      await save(ids.b, { active: true });
      expect((await load(ids.a)).relations.goesWith).toEqual([expect.objectContaining({ id: ids.b, active: true })]);
      await save(ids.b, { active: false });
      expect((await load(ids.a)).relations.goesWith).toEqual([
        expect.objectContaining({ id: ids.b, modelName: 'ZZRELB', active: false }),
      ]);
    });

    it('lists products with a thumbnail', async () => {
      const list = (await editor.get('/catalog/products?q=zzrel').expect(200)).body as AdminProductPage;
      const thumb = (id: number) => list.items.find((i) => i.id === id)?.thumbnailUrl;
      expect(thumb(ids.b)).toEqual(expect.any(String));
      expect(thumb(ids.c)).toBeNull();
    });
  });

  it('lets only the Super Admin delete a product for good', async () => {
    await owner.delete(`/catalog/products/${productId}`).expect(204);
    await storefront('/products/zzbreeze-three-seater-sofa').expect(404);
    const audit = (await owner.get(`/audit?entityType=product&entityId=${productId}`).expect(200)).body as AuditPage;
    expect(audit.items[0]).toMatchObject({ action: 'product.delete', entityLabel: 'ZZBREEZE' });
  });
});
