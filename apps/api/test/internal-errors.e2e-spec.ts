import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { ErrorEventsService } from './../src/system/error-events.service.js';

const TOKEN = 'e2e-internal-token-0123456789-abcdefghij';
const URL = '/api/internal/error-events';

// The storefront server's error reports (spec 9b.6): a shared token, 404 for anyone else, source forced to ssr.
describe('Internal error events (e2e, spec 9b.6)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let events: ErrorEventsService;
  let previous: string | undefined;

  const http = () => request(app.getHttpServer() as App);
  const rows = (text: string) => prisma.errorEvent.findMany({ where: { message: { contains: text } } });

  beforeAll(async () => {
    previous = process.env['INTERNAL_API_TOKEN'];
    process.env['INTERNAL_API_TOKEN'] = TOKEN;
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    events = app.get(ErrorEventsService);
    await prisma.errorEvent.deleteMany({ where: { message: { contains: 'Internal e2e' } } });
  });

  afterAll(async () => {
    await prisma.errorEvent.deleteMany({ where: { message: { contains: 'Internal e2e' } } });
    await app.close();
    if (previous === undefined) delete process.env['INTERNAL_API_TOKEN'];
    else process.env['INTERNAL_API_TOKEN'] = previous;
  });

  it('a valid report becomes an ssr row with the path without its query', async () => {
    await http()
      .post(URL)
      .set('X-Internal-Token', TOKEN)
      .send({
        kind: 'error',
        source: 'api',
        message: 'Internal e2e render failed for sentinel.user@example.test',
        stack: 'Error: Internal e2e render failed\n    at render (/app/server.mjs:1:1)',
        path: '/order/5001?t=order-token-secret',
      })
      .expect(204);
    await events.flush();
    const [row, ...more] = await rows('Internal e2e render failed');
    expect(more).toEqual([]);
    expect(row).toMatchObject({ kind: 'ERROR', source: 'SSR', path: '/order/5001', count: 1 });
    expect(row.message).toBe('Internal e2e render failed for [email]');
    expect(JSON.stringify(row)).not.toContain('order-token-secret');
  });

  it('answers 404 like an unknown route for a wrong or missing token', async () => {
    const unknown = await http().post('/api/internal/does-not-exist').send({ message: 'Internal e2e nope' });
    expect(unknown.status).toBe(404);
    for (const token of [undefined, 'wrong-token', `${TOKEN}x`]) {
      const req = http().post(URL);
      if (token) req.set('X-Internal-Token', token);
      const res = await req.send({ message: 'Internal e2e nope' });
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ ...unknown.body, message: 'Cannot POST /api/internal/error-events' });
    }
    await events.flush();
    expect(await rows('Internal e2e nope')).toEqual([]);
  });

  it('refuses a body over 16 KB with 413 and a missing message with 400', async () => {
    await http()
      .post(URL)
      .set('X-Internal-Token', TOKEN)
      .send({ message: 'Internal e2e big', stack: 'a'.repeat(20_000) })
      .expect(413);
    await http().post(URL).set('X-Internal-Token', TOKEN).send({ kind: 'error' }).expect(400);
    await events.flush();
    expect(await rows('Internal e2e big')).toEqual([]);
  });

  it('answers 204 and drops the report over 120 per minute', async () => {
    const body = { message: 'Internal e2e throttle' };
    let dropped = 0;
    for (let i = 0; i < 125; i++) {
      const res = await http().post(URL).set('X-Internal-Token', TOKEN).send(body);
      expect(res.status).toBe(204);
    }
    await events.flush();
    const [row] = await rows('Internal e2e throttle');
    dropped = 125 - row.count;
    expect(row.count).toBeLessThanOrEqual(120);
    expect(dropped).toBeGreaterThanOrEqual(5);
  });
});
