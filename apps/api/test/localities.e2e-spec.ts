import { Test } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

interface Row {
  id: number;
  nameHe: string;
}

// Runs against the e2e test database (migrated and seeded with the CBS list by test/e2e-global-setup.ts).
describe('Localities API (e2e, decision 71)', () => {
  let app: INestApplication<App>;
  const search = async (q?: string) => {
    const res = await request(app.getHttpServer())
      .get('/api/localities')
      .query(q === undefined ? {} : { q });
    expect(res.status).toBe(200);
    return res.body as Row[];
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const nest = moduleRef.createNestApplication<NestExpressApplication>();
    configureApp(nest);
    await nest.init();
    app = nest;
  });
  afterAll(async () => {
    await app.close();
  });

  it('is seeded with the full CBS list', async () => {
    const prisma = app.get(PrismaService);
    expect(await prisma.locality.count()).toBeGreaterThan(1200);
  });

  it('lists names starting with q before names containing q, each alphabetical', async () => {
    const rows = await search('תל');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThanOrEqual(10);
    const starts = rows.map((r) => r.nameHe.startsWith('תל'));
    expect(starts).toEqual([...starts].sort((a, b) => Number(b) - Number(a)));
    const prefix = rows.filter((r) => r.nameHe.startsWith('תל')).map((r) => r.nameHe);
    expect(prefix).toEqual([...prefix].sort((a, b) => a.localeCompare(b, 'he')));
    expect(rows.every((r) => r.nameHe.includes('תל'))).toBe(true);
    expect(rows[0]).toEqual({ id: expect.any(Number), nameHe: expect.any(String) });
  });

  it('puts contains matches after prefix matches', async () => {
    const rows = await search('אביב');
    expect(rows.some((r) => !r.nameHe.startsWith('אביב'))).toBe(true);
    const firstContains = rows.findIndex((r) => !r.nameHe.startsWith('אביב'));
    expect(rows.slice(firstContains).every((r) => !r.nameHe.startsWith('אביב'))).toBe(true);
  });

  it('returns at most 10', async () => {
    expect((await search('ב')).length).toBe(10);
  });

  it('treats gershayim and geresh variants as the same', async () => {
    const plain = await search('ניר ח"ן');
    expect(plain.map((r) => r.nameHe)).toContain('ניר ח"ן');
    expect(await search('ניר ח״ן')).toEqual(plain);
    expect(await search('  ניר   ח״ן ')).toEqual(plain);
    const geresh = await search("ג'ת");
    expect(geresh.length).toBeGreaterThan(0);
    expect(await search('ג׳ת')).toEqual(geresh);
  });

  it('returns [] for an empty or missing q, and for no match', async () => {
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
    expect(await search()).toEqual([]);
    expect(await search('zzzzqqqq')).toEqual([]);
  });
});
