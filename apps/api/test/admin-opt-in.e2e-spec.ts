import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { AdminMe, AuditPage } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';

/** The Super Admin's opt-in to orders.cancel (decision 73, ADM-04). */
describe('Super Admin opt-in (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let owner: AdminBrowser;
  let other: AdminBrowser;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    await resetAdminData(prisma);
    ({ owner, other } = await signInOwnerAnd(app, 'manager'));
  });

  afterAll(async () => {
    await resetAdminData(prisma);
    await app.close();
  });

  it('has no orders.cancel by default, and a manager does', async () => {
    expect(((await owner.get('/auth/me').expect(200)).body as AdminMe).permissions).not.toContain('orders.cancel');
    expect(((await other.get('/auth/me').expect(200)).body as AdminMe).permissions).toContain('orders.cancel');
  });

  it('refuses anyone but the Super Admin', async () => {
    await other.put('/users/me/opt-in', { permissions: ['orders.cancel'] }).expect(403);
  });

  it('refuses a key outside the opt-in list', async () => {
    await owner.put('/users/me/opt-in', { permissions: ['audit.view'] }).expect(400);
    await owner.put('/users/me/opt-in', { permissions: 'orders.cancel' }).expect(400);
  });

  it('adds orders.cancel, shows it in /me, audits it, and can take it back', async () => {
    await owner.put('/users/me/opt-in', { permissions: ['orders.cancel'] }).expect(200);
    expect(((await owner.get('/auth/me').expect(200)).body as AdminMe).permissions).toContain('orders.cancel');

    const audit = (await owner.get('/audit?entityType=admin_user').expect(200)).body as AuditPage;
    expect(audit.items.some((e) => e.action === 'user.opt_in')).toBe(true);

    await owner.put('/users/me/opt-in', { permissions: [] }).expect(200);
    expect(((await owner.get('/auth/me').expect(200)).body as AdminMe).permissions).not.toContain('orders.cancel');
  });
});
