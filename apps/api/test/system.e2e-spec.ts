import { Body, Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { acceptAndSignIn, resetAdminData, signInOwnerAnd, type AdminBrowser } from './admin-session.js';
import type { ErrorGroupDetail, ErrorGroupPage, SystemStatus } from '@hg/models';
import { AppLogger } from './../src/system/app-logger.js';
import { ErrorEventsService } from './../src/system/error-events.service.js';
import { fingerprint } from './../src/system/fingerprint.js';
import { SystemAlertsService } from './../src/system/system-alerts.service.js';
import { OutboxService } from './../src/outbox/outbox.service.js';

const DAY = 24 * 60 * 60_000;

/** Test-only routes: production code has no route that throws on purpose. */
@Controller('e2e-system')
class ThrowingController {
  constructor(private readonly prisma: PrismaService) {}

  /** A Prisma validation error whose argument tree holds a name and a street. */
  @Get('prisma')
  async prismaInvalid(): Promise<never> {
    await this.prisma.customerAddress.create({
      data: { street: 'Sentinel Street 5', houseNumber: '5', floor: 1, hasElevator: false, notes: 'Sentinel Person' },
    } as never);
    throw new Error('unreachable');
  }

  @Get('boom')
  boom(): never {
    throw new Error('System e2e boom for sentinel.user@example.test');
  }

  @Post('boom')
  boomPost(@Body() _body: unknown): never {
    throw new Error('System e2e post boom');
  }
}

// JSON logs and grouped error events (spec 9b.6, NFR-11). The flush timer is off in e2e (ERROR_EVENTS_WORKER=off):
// the tests call flush() and cleanup() themselves.
describe('System error events (e2e, spec 9b.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let events: ErrorEventsService;
  let stderr: { mockRestore(): void } | undefined;

  const http = () => request(app.getHttpServer() as App);
  const rows = (text: string) => prisma.errorEvent.findMany({ where: { message: { contains: text } } });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
      controllers: [ThrowingController],
    }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
    app.useLogger(app.get(AppLogger));
    await app.init();
    prisma = app.get(PrismaService);
    events = app.get(ErrorEventsService);
    await prisma.errorEvent.deleteMany({});
    // The thrown errors are printed by the logger; keep the test output readable.
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterAll(async () => {
    stderr?.mockRestore();
    await prisma.errorEvent.deleteMany({});
    await app.close();
  });

  it('a route that throws gives one row with path without the query string', async () => {
    await http().get('/api/e2e-system/boom?t=order-token-secret&x=1').expect(500);
    await http().get('/api/e2e-system/boom?t=another').expect(500);
    const changes = await events.flush();

    const [row, ...more] = await rows('System e2e boom');
    expect(more).toEqual([]);
    expect(row).toMatchObject({ kind: 'ERROR', source: 'API', path: '/api/e2e-system/boom', count: 2 });
    expect(row.message).toBe('System e2e boom for [email]');
    expect(row.stack).toContain('ThrowingController');
    expect(JSON.stringify(row)).not.toContain('order-token-secret');
    expect(Math.abs(row.lastSeen.getTime() - Date.now())).toBeLessThan(60_000);
    expect(changes).toEqual([expect.objectContaining({ id: row.id, isNew: true, reopened: false, count: 2 })]);
  });

  it('keeps the request path for a request with a JSON body', async () => {
    await http().post('/api/e2e-system/boom?preview=abc').send({ email: 'sentinel.user@example.test' }).expect(500);
    await events.flush();
    const [row] = await rows('System e2e post boom');
    expect(row.path).toBe('/api/e2e-system/boom');
    expect(JSON.stringify(row)).not.toContain('@example.test');
  });

  it('a 4xx is not an error event', async () => {
    await http().get('/api/products/no-such-product-e2e-system').expect(404);
    await events.flush();
    expect(await prisma.errorEvent.count({ where: { path: '/api/products/no-such-product-e2e-system' } })).toBe(0);
  });

  it('the same error after "handled" reopens the group', async () => {
    const [before] = await rows('System e2e boom');
    await prisma.errorEvent.update({ where: { id: before.id }, data: { handledAt: new Date() } });

    await http().get('/api/e2e-system/boom').expect(500);
    const changes = await events.flush();
    const after = await prisma.errorEvent.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.handledAt).toBeNull();
    expect(after.reopenedAt).not.toBeNull();
    expect(after.count).toBe(before.count + 1);
    expect(changes).toEqual([expect.objectContaining({ id: before.id, isNew: false, reopened: true })]);

    // Seen again while still open: counted, not reported again.
    await http().get('/api/e2e-system/boom').expect(500);
    expect(await events.flush()).toEqual([]);
    expect((await prisma.errorEvent.findUniqueOrThrow({ where: { id: before.id } })).count).toBe(before.count + 2);
  });

  it('a Prisma validation error is stored without the values of its arguments', async () => {
    await http().get('/api/e2e-system/prisma').expect(500);
    await events.flush();
    const [row, ...more] = await rows('prisma.customerAddress.create()');
    expect(more).toEqual([]);
    expect(row.message).toContain('[arguments]');
    expect(row.message).toContain('Argument `customer` is missing.');
    expect(JSON.stringify(row)).not.toContain('Sentinel');
  });

  it('caps the count at the largest int instead of failing the upsert', async () => {
    const message = 'System e2e count cap';
    const created = await prisma.errorEvent.create({
      data: {
        fingerprint: fingerprint({ kind: 'error', source: 'api', message }),
        kind: 'ERROR',
        source: 'API',
        message,
        count: 2_147_483_000,
        firstSeen: new Date(),
        lastSeen: new Date(),
      },
    });
    for (let i = 0; i < 1_000; i++) events.capture({ kind: 'error', source: 'api', message });
    await events.flush();
    expect((await prisma.errorEvent.findUniqueOrThrow({ where: { id: created.id } })).count).toBe(2_147_483_647);
  });

  it('cleanup deletes a group 31 days old and keeps one 29 days old', async () => {
    const now = Date.now();
    const make = (key: string, daysAgo: number) =>
      prisma.errorEvent.create({
        data: {
          fingerprint: `e2e-system-${key}`,
          kind: 'WARN',
          source: 'SSR',
          message: `System e2e cleanup ${key}`,
          count: 1,
          firstSeen: new Date(now - 40 * DAY),
          lastSeen: new Date(now - daysAgo * DAY),
        },
      });
    const old = await make('old', 31);
    const recent = await make('recent', 29);
    expect(await events.cleanup()).toBeGreaterThanOrEqual(1);
    expect(await prisma.errorEvent.findUnique({ where: { id: old.id } })).toBeNull();
    expect(await prisma.errorEvent.findUnique({ where: { id: recent.id } })).not.toBeNull();
  });
});

// The admin API of the system screen (spec 9b.6, permission `system.view`).
describe('System admin API (e2e, spec 9b.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let events: ErrorEventsService;
  let owner: AdminBrowser;
  let editor: AdminBrowser;
  let manager: AdminBrowser;
  let stderr: { mockRestore(): void } | undefined;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
    await app.init();
    prisma = app.get(PrismaService);
    events = app.get(ErrorEventsService);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await resetAdminData(prisma);
    ({ owner, other: editor } = await signInOwnerAnd(app, 'content_editor'));
    const created = await owner
      .post('/users', { email: 'manager@example.test', name: 'מנהל', template: 'manager' })
      .expect(201);
    manager = await acceptAndSignIn(
      app,
      { email: 'manager@example.test', password: 'terracotta lamp quiet river' },
      created.body.invite,
    );
    await prisma.errorEvent.deleteMany({});
    await prisma.backupRun.deleteMany({});
  });

  afterAll(async () => {
    stderr?.mockRestore();
    await prisma.errorEvent.deleteMany({});
    await prisma.backupRun.deleteMany({});
    await resetAdminData(prisma);
    await app.close();
  });

  beforeEach(async () => {
    await prisma.backupRun.deleteMany({});
  });

  const backup = (kind: 'DB' | 'MEDIA' | 'RESTORE_TEST', daysAgo: number, ok = true) =>
    prisma.backupRun.create({
      data: {
        kind,
        startedAt: new Date(Date.now() - daysAgo * DAY),
        finishedAt: new Date(Date.now() - daysAgo * DAY + 60_000),
        ok,
        bytes: 123456789n,
        objects: kind === 'MEDIA' ? 42 : null,
      },
    });

  it('refuses a user without system.view, a manager too, and an unsigned caller', async () => {
    for (const b of [editor, manager]) {
      await b.get('/system/status').expect(403);
      await b.get('/system/errors').expect(403);
      await b.get('/system/errors/1').expect(403);
      await b.post('/system/errors/1/handled').expect(403);
    }
    await request(app.getHttpServer() as App)
      .get('/api/admin/system/status')
      .set('Origin', 'http://localhost:4300')
      .expect(401);
  });

  it('gives the Super Admin the status with every field, no-store', async () => {
    await backup('DB', 0.5);
    await backup('MEDIA', 0.5);
    const res = await owner.get('/system/status').expect(200);
    expect(res.headers['cache-control']).toContain('no-store');
    const s = res.body as SystemStatus;
    expect(s.db).toBe('up');
    expect(typeof s.failedJobs).toBe('number');
    expect(s.diskFreeBytes === null || typeof s.diskFreeBytes === 'number').toBe(true);
    expect(s.diskTotalBytes === null || typeof s.diskTotalBytes === 'number').toBe(true);
    expect(s.lastBackup.db).toMatchObject({ kind: 'db', ok: true, bytes: 123456789, objects: null });
    expect(s.lastBackup.media).toMatchObject({ kind: 'media', ok: true, objects: 42 });
    expect(s.lastRestoreTest).toBeNull();
    expect(typeof s.version).toBe('string');
    expect(s.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('restoreTestStale: true with a DB backup and no (or a 40-day-old) restore test, false with a 10-day-old one or no backup', async () => {
    const stale = async () => ((await owner.get('/system/status').expect(200)).body as SystemStatus).restoreTestStale;
    expect(await stale()).toBe(false);
    await backup('DB', 1);
    expect(await stale()).toBe(true);
    await backup('RESTORE_TEST', 40);
    expect(await stale()).toBe(true);
    await backup('RESTORE_TEST', 10);
    expect(await stale()).toBe(false);
    const last = ((await owner.get('/system/status').expect(200)).body as SystemStatus).lastRestoreTest;
    expect(last?.kind).toBe('restore_test');
  });

  it('lists open errors newest first, handles one, audits it once and reopens it when it returns', async () => {
    const mk = (key: string, minsAgo: number, message: string) =>
      prisma.errorEvent.create({
        data: {
          fingerprint: `e2e-sysadmin-${key}`,
          kind: 'ERROR',
          source: 'API',
          message,
          stack: 'Error: x\n    at here',
          path: '/api/x',
          count: 3,
          firstSeen: new Date(Date.now() - 3 * DAY),
          lastSeen: new Date(Date.now() - minsAgo * 60_000),
        },
      });
    const older = await mk('older', 30, 'System admin older');
    const newer = await mk('newer', 5, 'System admin newer');

    const open = (await owner.get('/system/errors').expect(200)).body as ErrorGroupPage;
    expect(open.items.map((i) => i.id)).toEqual([newer.id, older.id]);
    expect(open).toMatchObject({ total: 2, page: 1, pageSize: 20 });
    expect(open.items[0]).not.toHaveProperty('stack');

    const detail = (await owner.get(`/system/errors/${newer.id}`).expect(200)).body as ErrorGroupDetail;
    expect(detail.stack).toContain('at here');
    expect(detail.handledBy).toBeNull();

    await owner.post(`/system/errors/${newer.id}/handled`).expect(204);
    await owner.post(`/system/errors/${newer.id}/handled`).expect(204);
    const audit = await prisma.auditLog.findMany({ where: { action: 'system.error_handled' } });
    expect(audit).toHaveLength(1);
    expect(audit[0].entityType).toBe('error_event');
    expect(audit[0].entityId).toBe(String(newer.id));

    expect(((await owner.get('/system/errors').expect(200)).body as ErrorGroupPage).items.map((i) => i.id)).toEqual([
      older.id,
    ]);
    const handled = (await owner.get('/system/errors?state=handled').expect(200)).body as ErrorGroupPage;
    expect(handled.items.map((i) => i.id)).toEqual([newer.id]);
    expect(handled.items[0].handledAt).not.toBeNull();
    expect(((await owner.get(`/system/errors/${newer.id}`).expect(200)).body as ErrorGroupDetail).handledBy).toBe(
      'בעלת העסק',
    );
    expect(((await owner.get('/system/errors?state=all').expect(200)).body as ErrorGroupPage).total).toBe(2);
  });

  it('a handled group reopens on a new occurrence and no longer names who handled it', async () => {
    events.capture({ kind: 'error', source: 'api', message: 'System admin returning error', path: '/api/y' });
    await events.flush();
    const row = await prisma.errorEvent.findFirstOrThrow({ where: { message: 'System admin returning error' } });
    await owner.post(`/system/errors/${row.id}/handled`).expect(204);
    events.capture({ kind: 'error', source: 'api', message: 'System admin returning error', path: '/api/y' });
    await events.flush();
    const open = (await owner.get('/system/errors').expect(200)).body as ErrorGroupPage;
    expect(open.items.find((i) => i.id === row.id)?.reopenedAt).not.toBeNull();
    const detail = (await owner.get(`/system/errors/${row.id}`).expect(200)).body as ErrorGroupDetail;
    expect(detail.handledAt).toBeNull();
    expect(detail.handledBy).toBeNull();
  });

  it('answers 400 with a code for a bad state or page, and 404 for an unknown or malformed id', async () => {
    expect((await owner.get('/system/errors?state=nope').expect(400)).body.code).toBe('invalid_input');
    expect((await owner.get('/system/errors?page=0').expect(400)).body.code).toBe('invalid_input');
    expect((await owner.get('/system/errors?page=x').expect(400)).body.code).toBe('invalid_input');
    await owner.get('/system/errors/99999999').expect(404);
    await owner.get('/system/errors/abc').expect(404);
    await owner.post('/system/errors/99999999/handled').expect(404);
  });
});

// Alert e-mails through the outbox (spec 9b.6): the real flush hook, the real transaction, the mock e-mail provider.
describe('System alerts (e2e, spec 9b.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let events: ErrorEventsService;
  let alerts: SystemAlertsService;
  let outbox: OutboxService;
  let stderr: { mockRestore(): void } | undefined;
  const saved = { alert: process.env.ALERT_EMAIL, backup: process.env.BACKUP_EXPECTED };

  const jobs = () => prisma.outboxJob.findMany({ where: { type: 'email.system_alert' } });
  const clean = async () => {
    await prisma.outboxJob.deleteMany({ where: { type: 'email.system_alert' } });
    await prisma.errorEvent.deleteMany({});
    await prisma.backupRun.deleteMany({});
    await prisma.notificationLog.deleteMany({ where: { template: 'system_alert' } });
  };

  beforeAll(async () => {
    process.env.ALERT_EMAIL = 'alerts@example.test';
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ bufferLogs: true }));
    app.useLogger(app.get(AppLogger));
    await app.init();
    prisma = app.get(PrismaService);
    events = app.get(ErrorEventsService);
    alerts = app.get(SystemAlertsService);
    outbox = app.get(OutboxService);
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  beforeEach(clean);

  afterAll(async () => {
    stderr?.mockRestore();
    await clean();
    for (const [name, value] of [
      ['ALERT_EMAIL', saved.alert],
      ['BACKUP_EXPECTED', saved.backup],
    ] as const)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    await app.close();
  });

  it('a new error group sends one scrubbed e-mail to ALERT_EMAIL and marks the group alerted', async () => {
    events.capture({
      kind: 'error',
      source: 'api',
      message: 'Alert e2e failure for sentinel.user@example.test',
      path: '/api/a?t=secret',
    });
    events.capture({ kind: 'warn', source: 'api', message: 'Alert e2e only a warning' });
    await events.flush();
    const [job, ...more] = await jobs();
    expect(more).toEqual([]);
    expect(JSON.stringify(job.payload)).not.toContain('@');
    expect(JSON.stringify(job.payload)).not.toContain('secret');
    expect(job.payload).toMatchObject({ reason: 'new_error', summary: 'Alert e2e failure for [email]' });
    const group = await prisma.errorEvent.findFirstOrThrow({ where: { message: { startsWith: 'Alert e2e failure' } } });
    expect(group.alertedAt).not.toBeNull();
    const warn = await prisma.errorEvent.findFirstOrThrow({ where: { message: 'Alert e2e only a warning' } });
    expect(warn.alertedAt).toBeNull();

    await outbox.runDue(10);
    const [log] = await prisma.notificationLog.findMany({ where: { template: 'system_alert' } });
    expect(log.status).toBe('SENT');
    expect(log.subject).toBe('NESTO: תקלה חדשה במערכת');
    expect(log.body).toContain('/system');
    expect(log.body).not.toContain('@');
  });

  it('a failed backup row alerts once; with no ALERT_EMAIL at send time the job completes without sending', async () => {
    const run = await prisma.backupRun.create({
      data: { kind: 'DB', startedAt: new Date(), finishedAt: new Date(), ok: false },
    });
    await alerts.checkBackups();
    await alerts.checkBackups();
    const list = await jobs();
    expect(list.map((j) => j.dedupeKey)).toEqual([`system_alert:backup_failed:${run.id}`]);
    expect((await prisma.backupRun.findUniqueOrThrow({ where: { id: run.id } })).alertedAt).not.toBeNull();

    delete process.env.ALERT_EMAIL;
    try {
      await outbox.runDue(10);
    } finally {
      process.env.ALERT_EMAIL = 'alerts@example.test';
    }
    expect((await prisma.outboxJob.findUniqueOrThrow({ where: { id: list[0].id } })).state).toBe('DONE');
    expect(await prisma.notificationLog.count({ where: { template: 'system_alert' } })).toBe(0);
  });

  it('a missing database backup alerts once a day, only with BACKUP_EXPECTED=true', async () => {
    const since = new Date(Date.now() - 27 * 60 * 60_000);
    await prisma.systemMark.upsert({
      where: { key: 'backup_watch_since' },
      create: { key: 'backup_watch_since', at: since },
      update: { at: since },
    });
    await alerts.checkBackups();
    expect(await jobs()).toEqual([]);
    process.env.BACKUP_EXPECTED = 'true';
    try {
      await alerts.checkBackups();
      await alerts.checkBackups();
    } finally {
      delete process.env.BACKUP_EXPECTED;
      await prisma.systemMark.deleteMany({});
    }
    const list = await jobs();
    expect(list).toHaveLength(1);
    expect(list[0].payload).toMatchObject({ reason: 'backup_missing', summary: 'db' });
  });
  it('the watch mark is written once on the first expected-backup check and never moves', async () => {
    await prisma.systemMark.deleteMany({});
    process.env.BACKUP_EXPECTED = 'true';
    try {
      await alerts.checkBackups();
      const first = await prisma.systemMark.findUniqueOrThrow({ where: { key: 'backup_watch_since' } });
      await alerts.checkBackups();
      const second = await prisma.systemMark.findUniqueOrThrow({ where: { key: 'backup_watch_since' } });
      expect(second.at).toEqual(first.at);
    } finally {
      delete process.env.BACKUP_EXPECTED;
      await prisma.systemMark.deleteMany({});
    }
  });
});
