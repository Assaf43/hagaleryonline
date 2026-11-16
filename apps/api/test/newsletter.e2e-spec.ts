import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { MarketingStatus } from './../src/generated/prisma/client.js';
import { EMAIL_PROVIDER, type EmailProvider } from './../src/notifications/notification-provider.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { OutboxService } from './../src/outbox/outbox.service.js';
import { PrismaService } from './../src/prisma/prisma.service.js';
import { deleteMarketingContacts } from './test-marketing.js';
import { uniqueIds } from './unique-ids.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@news.e2e.test';
const RELAXED = 1000;

// Phase 7 §4.4, §6 (MKT-01, CLB-02, decision 95): the newsletter sign-up answers the same whatever the address is.
describe('Newsletter (e2e, MKT-01, CLB-02)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let outbox: OutboxService;
  let throttle: WriteThrottle;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  const unique = uniqueIds(7);
  const newEmail = () => `n${unique()}${DOMAIN}`;

  const post = (path: string, body: object, origin: string | null = ORIGIN) => {
    const req = request(app.getHttpServer() as App).post(`/api/newsletter${path}`);
    return (origin ? req.set('Origin', origin) : req).send(body);
  };
  const mailsTo = (to: string) => emailSpy.mock.calls.map(([m]) => m).filter((m) => m.to === to);
  const linkIn = (to: string, path: 'confirm' | 'unsubscribe') => {
    const text = mailsTo(to).at(-1)!;
    return new RegExp(`/newsletter/${path}\\?t=([\\w-]+)`).exec(`${text.text} ${text.html ?? ''}`)![1];
  };
  const contactOf = (email: string) =>
    prisma.marketingContact.findUnique({ where: { email }, include: { events: { orderBy: { id: 'asc' } } } });
  const cleanData = async () => {
    await prisma.outboxJob.deleteMany({});
    await deleteMarketingContacts(prisma, { email: { endsWith: DOMAIN } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>({ rawBody: true }));
    await app.init();
    prisma = app.get(PrismaService);
    outbox = app.get(OutboxService);
    throttle = app.get(WriteThrottle);
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    await cleanData();
  });

  beforeEach(() => {
    emailSpy.mockClear();
    throttle.setLimit('newsletter', RELAXED);
    throttle.setLimit('newsletter_unsubscribe', RELAXED);
  });
  afterEach(cleanData);
  afterAll(async () => {
    await cleanData();
    await app.close();
  });

  it('answers 202 {} always; five posts of one address send three e-mails; a subscribed one sends none', async () => {
    const email = newEmail();
    for (let i = 0; i < 5; i++) {
      const res = await post('', { email, consent: true, website: '' });
      expect(res.status).toBe(202);
      expect(res.body).toEqual({});
      expect(res.headers['cache-control']).toBe('no-store');
    }
    await outbox.runDue(100);
    expect(mailsTo(email)).toHaveLength(3);
    expect(await contactOf(email)).toMatchObject({ status: MarketingStatus.PENDING, source: 'NEWSLETTER' });

    const confirm = await post('/confirm', { token: linkIn(email, 'confirm') });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toEqual({ email: expect.stringContaining('*') });
    expect(confirm.body.email).not.toBe(email);
    expect(confirm.headers['cache-control']).toBe('no-store');
    const events = (await contactOf(email))!.events.length;

    emailSpy.mockClear();
    expect((await post('', { email, consent: true })).status).toBe(202);
    await outbox.runDue(100);
    expect(mailsTo(email)).toHaveLength(0);
    expect((await contactOf(email))!.events).toHaveLength(events);
  });

  it('validates: a bad e-mail → 400 field email; consent not true → 400 field consent', async () => {
    const bad = await post('', { email: 'nope', consent: true });
    expect(bad.status).toBe(400);
    expect(bad.body).toMatchObject({ code: 'invalid_input', field: 'email' });
    const noConsent = await post('', { email: newEmail(), consent: 'yes' });
    expect(noConsent.status).toBe(400);
    expect(noConsent.body).toMatchObject({ code: 'invalid_input', field: 'consent' });
    expect((await post('', { email: newEmail() })).body).toMatchObject({ field: 'consent' });
  });

  it('the honeypot answers 202 {} and saves nothing', async () => {
    const email = newEmail();
    const res = await post('', { email, consent: true, website: 'http://spam.example' });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({});
    expect(await contactOf(email)).toBeNull();
    await outbox.runDue(100);
    expect(mailsTo(email)).toHaveLength(0);
  });

  it('confirm: subscribed once; the second use and an unknown token → 404 link_invalid', async () => {
    const email = newEmail();
    await post('', { email, consent: true });
    await outbox.runDue(100);
    const token = linkIn(email, 'confirm');
    expect((await post('/confirm', { token })).status).toBe(200);
    expect(await contactOf(email)).toMatchObject({ status: MarketingStatus.SUBSCRIBED });
    const again = await post('/confirm', { token });
    expect(again.status).toBe(404);
    expect(again.body).toMatchObject({ code: 'link_invalid' });
    expect((await post('/confirm', { token: 'nope' })).status).toBe(404);
    expect((await post('/confirm', {})).status).toBe(404);
  });

  it('preview reads the link without using it: masked address, the contact stays pending, the token still confirms', async () => {
    const email = newEmail();
    await post('', { email, consent: true });
    await outbox.runDue(100);
    const token = linkIn(email, 'confirm');
    const before = await contactOf(email);

    for (let i = 0; i < 2; i++) {
      const preview = await post('/confirm/preview', { token });
      expect(preview.status).toBe(200);
      expect(preview.body).toEqual({ email: expect.stringContaining('*') });
      expect(preview.body.email).not.toBe(email);
      expect(preview.headers['cache-control']).toBe('no-store');
    }
    // Nothing changed: no new event, the same token hash, still pending.
    const after = await contactOf(email);
    expect(after).toMatchObject({ status: MarketingStatus.PENDING, confirmTokenHash: before!.confirmTokenHash });
    expect(after!.events).toHaveLength(before!.events.length);
    expect(after!.syncVersion).toBe(before!.syncVersion);

    // The click confirms with the same token; afterwards the preview and the confirm answer 404.
    const confirm = await post('/confirm', { token });
    expect(confirm.status).toBe(200);
    expect(confirm.body).toEqual({ email: expect.stringContaining('*') });
    expect(await contactOf(email)).toMatchObject({ status: MarketingStatus.SUBSCRIBED });
    const used = await post('/confirm/preview', { token });
    expect(used.status).toBe(404);
    expect(used.body).toMatchObject({ code: 'link_invalid' });
    expect((await post('/confirm/preview', { token: 'nope' })).status).toBe(404);
    expect((await post('/confirm/preview', {})).status).toBe(404);
    expect((await post('/confirm/preview', { token }, 'http://evil.example')).status).toBe(403);
  });

  it('unsubscribe by token → 204 and unsubscribed; an unknown token → 204 too', async () => {
    const email = newEmail();
    await post('', { email, consent: true });
    await outbox.runDue(100);
    await post('/confirm', { token: linkIn(email, 'confirm') });
    const res = await post('/unsubscribe', { token: linkIn(email, 'unsubscribe') });
    expect(res.status).toBe(204);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(await contactOf(email)).toMatchObject({ status: MarketingStatus.UNSUBSCRIBED });
    expect((await post('/unsubscribe', { token: 'unknown' })).status).toBe(204);
  });

  it('needs the storefront origin', async () => {
    expect((await post('', { email: newEmail(), consent: true }, null)).status).toBe(403);
    expect((await post('/confirm', { token: 'x' }, 'http://evil.example')).status).toBe(403);
  });

  it('per IP: sign-up, preview and confirm share the newsletter bucket → 429 with Retry-After', async () => {
    throttle.setLimit('newsletter', 2);
    expect((await post('', { email: newEmail(), consent: true })).status).toBe(202);
    expect((await post('/confirm/preview', { token: 'x' })).status).toBe(404);
    const res = await post('/confirm', { token: 'x' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    // Unsubscribing has its own bucket: a shared IP over the sign-up limit can still leave the list.
    expect((await post('/unsubscribe', { token: 'x' })).status).toBe(204);
  });

  it('per IP: unsubscribe over its own newsletter_unsubscribe limit → 429', async () => {
    throttle.setLimit('newsletter_unsubscribe', 1);
    expect((await post('/unsubscribe', { token: 'x' })).status).toBe(204);
    const res = await post('/unsubscribe', { token: 'x' });
    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();
    expect((await post('', { email: newEmail(), consent: true })).status).toBe(202);
  });
});
