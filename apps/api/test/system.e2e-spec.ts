import { Body, Controller, Get, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { AppLogger } from './../src/system/app-logger.js';
import { ErrorEventsService } from './../src/system/error-events.service.js';

const DAY = 24 * 60 * 60_000;

/** Test-only routes: production code has no route that throws on purpose. */
@Controller('e2e-system')
class ThrowingController {
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
