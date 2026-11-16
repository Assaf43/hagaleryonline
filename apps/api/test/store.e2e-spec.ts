import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { OneTimeLink, StoreInfo } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { StoreService } from './../src/store-orders/store.service.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

// The store entity (Phase 6, ADM-18, spec §4.4–§4.6): one seeded row, read and edited by the Super Admin only.
describe('Store entity (e2e, ADM-18)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let seller: AdminBrowser;
  let manager: AdminBrowser;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    ({ owner, other: seller } = await signInOwnerAnd(app, 'store_seller'));
    const created = await owner
      .post('/users', { email: 'manager@example.test', name: 'מנהל', template: 'manager' })
      .expect(201);
    manager = await acceptAndSignIn(
      app,
      { email: 'manager@example.test', password: 'pebble garden lantern ocean' },
      created.body.invite as OneTimeLink,
    );
  });

  afterAll(async () => {
    await prisma.store.update({
      where: { id: (await app.get(StoreService).activeStore()).id },
      data: { nameHe: 'החנות', address: '', hoursHe: '', phone: '' },
    });
    await resetAdminData(prisma);
    await app.close();
  });

  it('has the one store row from the migration', async () => {
    const store = await app.get(StoreService).activeStore();
    expect(store.id).toEqual(expect.any(Number));
    expect(await prisma.store.count()).toBe(1);
  });

  it('lets the Super Admin read and update it, with an audit row', async () => {
    const read = await owner.get('/store').expect(200);
    expect(read.body).toEqual({ id: expect.any(Number), nameHe: 'החנות', address: '', hoursHe: '', phone: '' });
    const saved = await owner
      .put('/store', {
        nameHe: '  סניף מרכז ',
        address: 'הרצל 1, תל אביב',
        hoursHe: 'א׳–ה׳ 10:00–19:00',
        phone: '03-1234567',
      })
      .expect(200);
    expect((saved.body as StoreInfo).nameHe).toBe('סניף מרכז');
    expect((await owner.get('/store').expect(200)).body).toMatchObject({ address: 'הרצל 1, תל אביב' });
    const audit = await prisma.auditLog.findMany({ where: { action: 'store.update' } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ entityType: 'store', after: expect.objectContaining({ nameHe: 'סניף מרכז' }) });
  });

  it('refuses everybody but the Super Admin', async () => {
    await seller.get('/store').expect(403);
    await seller.put('/store', { nameHe: 'x', address: '', hoursHe: '', phone: '' }).expect(403);
    await manager.get('/store').expect(403);
  });

  it('validates the fields', async () => {
    const ok = { nameHe: 'חנות', address: '', hoursHe: '', phone: '' };
    const blank = await owner.put('/store', { ...ok, nameHe: '   ' }).expect(400);
    expect(blank.body).toMatchObject({ code: 'invalid_input', field: 'nameHe' });
    await owner.put('/store', { ...ok, nameHe: 'x'.repeat(81) }).expect(400);
    const long = await owner.put('/store', { ...ok, address: 'x'.repeat(201) }).expect(400);
    expect(long.body).toMatchObject({ field: 'address' });
    await owner.put('/store', { ...ok, phone: 5 }).expect(400);
  });

  it('throws 503 store_not_configured without an active store', async () => {
    await prisma.store.updateMany({ data: { active: false } });
    try {
      await expect(app.get(StoreService).activeStore()).rejects.toMatchObject({
        response: { code: 'store_not_configured' },
        status: 503,
      });
    } finally {
      await prisma.store.updateMany({ data: { active: true } });
    }
  });
});
