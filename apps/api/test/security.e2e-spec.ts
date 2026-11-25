import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';

describe('API security headers and error bodies (NFR-07, e2e)', () => {
  let app: NestExpressApplication;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const expectHeaders = (headers: Record<string, unknown>, csp = "default-src 'none'; frame-ancestors 'none'") => {
    expect(headers['content-security-policy']).toBe(csp);
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-frame-options']).toBe('DENY');
  };

  it('GET /api/health carries all four headers', async () => {
    expectHeaders((await request(app.getHttpServer()).get('/api/health').expect(200)).headers);
  });

  it('a 404 and a static /media miss carry them too', async () => {
    expectHeaders((await request(app.getHttpServer()).get('/api/no-such-route').expect(404)).headers);
    // The static handler's own error page sets a CSP of its own; X-Frame-Options still covers framing.
    expectHeaders(
      (await request(app.getHttpServer()).get('/media/no-such-file.webp').expect(404)).headers,
      "default-src 'none'",
    );
  });

  it('an unknown route answers { statusCode, message, error } with no path, stack or internals', async () => {
    const res = await request(app.getHttpServer()).get('/api/no-such-route').expect(404);
    expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(res.body.statusCode).toBe(404);
    expect(JSON.stringify(res.body)).not.toMatch(/stack|node_modules|\.ts/);
  });

  it('malformed JSON answers 400 without a stack or the raw input', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/newsletter')
      .set('Content-Type', 'application/json')
      .set('Origin', 'http://localhost:4200')
      .send('{"a": SECRETMARKER}')
      .expect(400);
    const text = JSON.stringify(res.body);
    expect(res.body.stack).toBeUndefined();
    expect(text).not.toContain('SECRETMARKER');
    expect(Object.keys(res.body).sort()).toEqual(['error', 'message', 'statusCode']);
    expect(text).not.toMatch(/node_modules|body-parser|position|token/i);
    expectHeaders(res.headers);
  });
});
