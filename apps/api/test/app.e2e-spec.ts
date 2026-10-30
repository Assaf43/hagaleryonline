import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';

// Needs the database container: `npm run db:up`.
describe('API (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = configureApp(moduleFixture.createNestApplication<NestExpressApplication>());
    await app.init();
  });

  it('GET /api/health reports the database as up', () => {
    return request(app.getHttpServer()).get('/api/health').expect(200).expect({ status: 'ok', db: 'up' });
  });

  afterEach(async () => {
    await app.close();
  });
});
