import type { AddressInfo } from 'node:net';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { FAVORITES_MAX } from '@hg/models';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './../src/app.module.js';
import { hashPassword } from './../src/auth/passwords.js';
import { CacheStore } from './../src/cache/cache-store.js';
import { configureApp } from './../src/configure-app.js';
import { MarketingConsentSource, MarketingStatus } from './../src/generated/prisma/client.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { deleteMarketingContacts } from './test-marketing.js';
import { uniqueIds } from './unique-ids.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@fav0.e2e.test';
const PASSWORD = 'correct horse 0';
const SLUG_PREFIX = 'zz-fav-';

// Favorites on the account (Phase 7c, spec §5.5, CLB-09).
describe('Account favorites (e2e, CLB-09)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  /** 120 products (more than the cap), ascending ids. */
  let products: number[];
  const unique = uniqueIds(0);

  const http = () => request(app.getHttpServer() as App);

  const cleanup = async () => {
    await prisma.customer.deleteMany({ where: { email: { endsWith: DOMAIN } } });
    await deleteMarketingContacts(prisma, { email: { endsWith: DOMAIN } });
    await prisma.outboxJob.deleteMany({ where: { dedupeKey: { startsWith: 'marketing.sync:' } } });
  };

  /** A new account (created directly) and an agent signed in to it. */
  const member = async () => {
    const id = unique();
    const email = `user${id}${DOMAIN}`;
    const customer = await prisma.customer.create({
      data: {
        fullName: 'ZZ דנה לוי',
        phone: `05${id}`,
        email,
        passwordHash: await hashPassword(PASSWORD),
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: new Date(),
      },
    });
    const agent = request.agent(app.getHttpServer() as App);
    await agent.post('/api/account/sign-in').set('Origin', ORIGIN).send({ email, password: PASSWORD }).expect(200);
    return { customer, agent };
  };
  type Agent = Awaited<ReturnType<typeof member>>['agent'];
  const list = async (agent: Agent) => {
    const res = await agent.get('/api/account/favorites').expect(200);
    expect(res.headers['cache-control']).toBe('no-store');
    return res.body as number[];
  };
  const put = (agent: Agent, productIds: unknown) =>
    agent.put('/api/account/favorites').set('Origin', ORIGIN).send({ productIds });
  const del = (agent: Agent, id: string | number) => agent.delete(`/api/account/favorites/${id}`).set('Origin', ORIGIN);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.listen(0, '127.0.0.1');
    process.env.API_INTERNAL_URL = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;
    prisma = app.get(PrismaService);
    await cleanup();
    await prisma.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.category.deleteMany({ where: { slug: 'zz-fav' } });
    const category = await prisma.category.create({ data: { slug: 'zz-fav', nameHe: 'בדיקת מועדפים' } });
    products = [];
    for (let i = 0; i < 120; i++) {
      const p = await prisma.product.create({
        data: { slug: `${SLUG_PREFIX}${i}`, modelName: `ZZFAV${i}`, nameHe: `מוצר ${i}`, categoryId: category.id },
      });
      products.push(p.id);
    }
  });

  afterAll(async () => {
    await cleanup();
    await prisma.product.deleteMany({ where: { slug: { startsWith: SLUG_PREFIX } } });
    await prisma.category.deleteMany({ where: { slug: 'zz-fav' } });
    await app.get(CacheStore).invalidate('catalog:');
    await app.close();
  });

  afterEach(cleanup);

  it('needs a session and the storefront origin', async () => {
    await http().get('/api/account/favorites').expect(401);
    const { agent } = await member();
    await agent.put('/api/account/favorites').send({ productIds: [] }).expect(403);
    await agent.delete(`/api/account/favorites/${products[0]}`).expect(403);
  });

  it('merges as a union, the sent new ones first in the order sent, and keeps what is saved', async () => {
    const { agent } = await member();
    expect(await list(agent)).toEqual([]);
    expect((await put(agent, [products[0], products[1]]).expect(200)).body).toEqual([products[0], products[1]]);
    const res = await put(agent, [products[3], products[1], products[2]]).expect(200);
    expect(res.body).toEqual([products[3], products[2], products[0], products[1]]);
    expect(await list(agent)).toEqual(res.body);
    // The same ids again change nothing.
    expect((await put(agent, [products[3], products[2]]).expect(200)).body).toEqual(res.body);
  });

  it('drops unknown products silently', async () => {
    const { agent } = await member();
    const res = await put(agent, [products[0], 2_000_000_000, products[1]]).expect(200);
    expect(res.body).toEqual([products[0], products[1]]);
  });

  it('caps the list at 100, dropping the oldest', async () => {
    const { agent } = await member();
    await put(agent, products.slice(0, 80)).expect(200);
    const res = await put(agent, products.slice(80, 120)).expect(200);
    const ids = res.body as number[];
    expect(ids).toHaveLength(FAVORITES_MAX);
    // The 40 new ones lead; of the 80 saved, the 60 newest stay.
    expect(ids.slice(0, 40)).toEqual(products.slice(80, 120));
    expect(ids.slice(40)).toEqual(products.slice(0, 60));
    expect(await list(agent)).toEqual(ids);
  });

  it('rejects malformed input', async () => {
    const { agent } = await member();
    const tooMany = Array.from({ length: 201 }, (_, i) => i + 1);
    for (const bad of [undefined, 'x', [1.5], [0], [-1], ['1'], [null], tooMany]) {
      const res = await put(agent, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.body).toMatchObject({ code: 'invalid_input', field: 'productIds' });
    }
    await del(agent, 'abc').expect(400);
  });

  it('removes one; an id that is not in the list is a 204 too', async () => {
    const { agent } = await member();
    await put(agent, [products[0], products[1]]).expect(200);
    await del(agent, products[0]).expect(204);
    expect(await list(agent)).toEqual([products[1]]);
    await del(agent, products[0]).expect(204);
    await del(agent, 2_000_000_000).expect(204);
    expect(await list(agent)).toEqual([products[1]]);
  });

  it('keeps each account to its own list, and deleting the account deletes the list', async () => {
    const a = await member();
    const b = await member();
    await put(a.agent, [products[0]]).expect(200);
    expect(await list(b.agent)).toEqual([]);
    await prisma.customer.delete({ where: { id: a.customer.id } });
    expect(await prisma.customerFavorite.count({ where: { customerId: a.customer.id } })).toBe(0);
  });

  it('syncs the contact only when the list changed', async () => {
    const { customer, agent } = await member();
    const contact = await prisma.marketingContact.create({
      data: {
        email: customer.email!,
        customerId: customer.id,
        status: MarketingStatus.SUBSCRIBED,
        source: MarketingConsentSource.ACCOUNT,
        consentAt: new Date(),
        unsubscribeTokenHash: `h${unique()}`,
      },
    });
    const version = async () =>
      (await prisma.marketingContact.findUniqueOrThrow({ where: { id: contact.id } })).syncVersion;
    const v0 = await version();
    await put(agent, [products[0]]).expect(200);
    expect(await version()).toBe(v0 + 1);
    expect(await prisma.outboxJob.count({ where: { dedupeKey: `marketing.sync:${contact.id}:${v0 + 1}` } })).toBe(1);
    await put(agent, [products[0]]).expect(200);
    await del(agent, products[5]).expect(204);
    expect(await version()).toBe(v0 + 1);
    await del(agent, products[0]).expect(204);
    expect(await version()).toBe(v0 + 2);
  });
});
