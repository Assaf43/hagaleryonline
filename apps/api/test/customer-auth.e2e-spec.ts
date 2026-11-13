import { createHash } from 'node:crypto';
import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import type { CustomerMe } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { MarketingConsentSource } from './../src/generated/prisma/client.js';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from './../src/notifications/notification-provider.js';
import { WriteThrottle } from './../src/orders/write-throttle.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@acc.e2e.test';
const DAY_MS = 24 * 60 * 60_000;
const COOKIE = 'hg_customer';

// Customer accounts (spec §6.1, §6.2, ACC-01, NFR-12, decision 80). Codes are read from the mock providers' calls,
// never from the API.
describe('Customer accounts (e2e, ACC-01, NFR-12)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let throttle: WriteThrottle;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  let seq = 0;

  const unique = () => String(++seq).padStart(4, '0') + String(Date.now() % 10_000).padStart(4, '0');
  const newPhone = () => `05${unique()}`;
  const newEmail = () => `user${unique()}${DOMAIN}`;

  /** A storefront browser: keeps cookies and sends the storefront's Origin on writes. */
  const browser = () => {
    const agent = request.agent(app.getHttpServer() as App);
    const post = (path: string, body: object = {}) =>
      agent.post(`/api/account/${path}`).set('Origin', ORIGIN).send(body);
    return { agent, post, me: () => agent.get('/api/account/me') };
  };
  const smsCode = (to: string) => {
    const call = smsSpy.mock.calls.filter(([m]) => m.to === to).at(-1);
    return call ? /(\d{6})/.exec(call[0].text)![1] : undefined;
  };
  const emailCode = (to: string) => {
    const call = emailSpy.mock.calls.filter(([m]) => m.to === to).at(-1);
    return call ? /(\d{6})/.exec(call[0].text)![1] : undefined;
  };
  const sentTo = (to: string) =>
    smsSpy.mock.calls.filter(([m]) => m.to === to).length + emailSpy.mock.calls.filter(([m]) => m.to === to).length;
  const wrongOf = (code: string) => String((Number(code) + 1) % 1_000_000).padStart(6, '0');
  const customerCookie = (res: request.Response) =>
    ([res.headers['set-cookie'] ?? []].flat() as string[]).find((c) => c.startsWith(`${COOKIE}=`));
  const tokenOf = (cookie: string) => decodeURIComponent(cookie.split(';')[0].slice(COOKIE.length + 1));
  const sha = (value: string) => createHash('sha256').update(value).digest('hex');

  /** Verifies the sign-up codes sent to the phone and the e-mail; returns the ticket that covers both. */
  const verifyBoth = async (b: ReturnType<typeof browser>, phone: string, email: string) => {
    const first = await b.post('otp/verify', { target: phone, code: smsCode(phone), purpose: 'sign_up' }).expect(200);
    const second = await b
      .post('otp/verify', {
        target: email,
        code: emailCode(email),
        purpose: 'sign_up',
        signUpToken: first.body.signUpToken,
      })
      .expect(200);
    return second.body.signUpToken as string;
  };

  /** Signs up with both codes; returns the signed-in browser. */
  const signUp = async (opts: { password?: string; marketingConsent?: boolean; phone?: string } = {}) => {
    const phone = opts.phone ?? newPhone();
    const email = newEmail();
    const b = browser();
    const details = {
      fullName: 'דנה לוי',
      phone,
      email,
      password: opts.password,
      marketingConsent: opts.marketingConsent ?? false,
    };
    await b.post('sign-up', details).expect(200, { verify: true });
    const signUpToken = await verifyBoth(b, phone, email);
    await b.post('sign-up', { ...details, signUpToken }).expect(200);
    return { b, phone, email };
  };

  const cleanup = async () => {
    await prisma.otpCode.deleteMany({});
    await prisma.customer.deleteMany({ where: { email: { endsWith: DOMAIN } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    throttle = app.get(WriteThrottle);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('sign-up (decision 80: both phone and e-mail verified by a code)', () => {
    it('two codes: one to the phone, one to the e-mail; the account is created only when both are entered', async () => {
      const phone = newPhone();
      const email = newEmail();
      const b = browser();
      const details = {
        fullName: '  דנה לוי ',
        phone: `+972-${phone.slice(1)}`,
        email,
        password: 'correct horse 1',
        marketingConsent: true,
      };
      await b.post('sign-up', details).expect(200, { verify: true });
      expect(await prisma.customer.count({ where: { phone } })).toBe(0);
      const code = smsCode(phone)!;
      expect(code).toMatch(/^\d{6}$/);
      expect(emailCode(email)).toMatch(/^\d{6}$/);

      await b.post('otp/verify', { target: phone, code: wrongOf(code), purpose: 'sign_up' }).expect(401);
      const first = await b.post('otp/verify', { target: phone, code, purpose: 'sign_up' }).expect(200);
      expect(first.body).toMatchObject({ needsSignUp: true, verified: { phone, email: null } });
      expect(customerCookie(first)).toBeUndefined();

      // Only the phone is verified so far.
      await b
        .post('sign-up', { ...details, signUpToken: first.body.signUpToken })
        .expect(400)
        .expect((r) => expect(r.body).toMatchObject({ code: 'not_verified', field: 'email' }));

      const second = await b
        .post('otp/verify', {
          target: email,
          code: emailCode(email),
          purpose: 'sign_up',
          signUpToken: first.body.signUpToken,
        })
        .expect(200);
      expect(second.body).toMatchObject({ needsSignUp: true, verified: { phone, email } });
      const signUpToken = second.body.signUpToken as string;

      const res = await b.post('sign-up', { ...details, signUpToken }).expect(200);
      const me = (res.body as { customer: CustomerMe }).customer;
      expect(me).toMatchObject({
        fullName: 'דנה לוי',
        phone,
        email,
        phoneVerified: true,
        emailVerified: true,
        hasPassword: true,
        marketingConsent: true,
      });
      expect(customerCookie(res)).toBeDefined();
      expect((await b.me().expect(200)).body).toEqual(me);

      const row = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.marketingConsentSource).toBe(MarketingConsentSource.SIGNUP);
      expect(row.marketingConsentAt).not.toBeNull();

      await browser()
        .post('sign-up', { ...details, email: newEmail(), signUpToken })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('invalid_token'));
    });

    it('without consent stores no consent time', async () => {
      const { phone } = await signUp();
      const row = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      expect(row).toMatchObject({ marketingConsent: false, marketingConsentAt: null, passwordHash: null });
    });

    it('refuses a duplicate phone or e-mail with 409 phone_taken / email_taken', async () => {
      const { phone, email } = await signUp();
      const b = browser();
      const base = { fullName: 'אחר', marketingConsent: false };
      await b
        .post('sign-up', { ...base, phone, email: newEmail() })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('phone_taken'));
      await b
        .post('sign-up', { ...base, phone: newPhone(), email: email.toUpperCase() })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('email_taken'));
    });

    it('repeated 409s count against the per-IP code limit and reach 429', async () => {
      const { phone } = await signUp();
      throttle.setLimit('otp', 3);
      try {
        const b = browser();
        for (let i = 0; i < 3; i++)
          await b.post('sign-up', { fullName: 'אחר', phone, email: newEmail(), marketingConsent: false }).expect(409);
        await b.post('sign-up', { fullName: 'אחר', phone, email: newEmail(), marketingConsent: false }).expect(429);
      } finally {
        throttle.setLimit('otp', 100_000);
      }
    });

    it('refuses a bad phone, e-mail, name or password with 400', async () => {
      const b = browser();
      const ok = { fullName: 'דנה לוי', phone: newPhone(), email: newEmail(), marketingConsent: false };
      for (const [field, value] of [
        ['phone', '031234567'],
        ['email', 'nope'],
        ['fullName', 'ד'],
        ['password', 'short'],
        ['marketingConsent', 'yes'],
      ] as const) {
        const res = await b.post('sign-up', { ...ok, [field]: value }).expect(400);
        expect(res.body.field).toBe(field);
      }
    });

    it('a sign-in code for an unknown phone continues to sign-up; the e-mail still needs its code', async () => {
      const phone = newPhone();
      const email = newEmail();
      const b = browser();
      await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202, { sent: true });
      const res = await b.post('otp/verify', { target: phone, code: smsCode(phone) }).expect(200);
      expect(res.body).toMatchObject({ needsSignUp: true, verified: { phone, email: null } });
      expect(customerCookie(res)).toBeUndefined();

      await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_up' }).expect(202, { sent: true });
      await b
        .post('otp/verify', { target: email, code: emailCode(email), purpose: 'sign_up', signUpToken: 'forged' })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('invalid_token'));
      const both = await b
        .post('otp/verify', {
          target: email,
          code: emailCode(email),
          purpose: 'sign_up',
          signUpToken: res.body.signUpToken,
        })
        .expect(200);
      const done = await b
        .post('sign-up', { signUpToken: both.body.signUpToken, fullName: 'דנה', phone, email, marketingConsent: false })
        .expect(200);
      expect(done.body.customer).toMatchObject({ phone, email, phoneVerified: true, emailVerified: true });
      expect(customerCookie(done)).toBeDefined();
    });

    it('pre-account hijack: a verified e-mail cannot carry an unverified phone of somebody else', async () => {
      const victimPhone = newPhone();
      const attackerEmail = newEmail();
      const attacker = browser();
      await attacker.post('otp/request', { target: attackerEmail, channel: 'email', purpose: 'sign_in' }).expect(202);
      const { body } = await attacker
        .post('otp/verify', { target: attackerEmail, code: emailCode(attackerEmail) })
        .expect(200);
      expect(body.verified).toEqual({ phone: null, email: attackerEmail });

      await attacker
        .post('sign-up', {
          signUpToken: body.signUpToken,
          fullName: 'תוקף',
          phone: victimPhone,
          email: attackerEmail,
          marketingConsent: false,
        })
        .expect(400)
        .expect((r) => expect(r.body).toMatchObject({ code: 'not_verified', field: 'phone' }));
      // A code the attacker cannot read does not help either.
      await attacker.post('otp/request', { target: victimPhone, channel: 'sms', purpose: 'sign_up' }).expect(202);
      await attacker
        .post('otp/verify', {
          target: victimPhone,
          code: wrongOf(smsCode(victimPhone)!),
          purpose: 'sign_up',
          signUpToken: body.signUpToken,
        })
        .expect(401);
      expect(await prisma.customer.count({ where: { phone: victimPhone } })).toBe(0);

      // The victim signs up with the phone as usual.
      const { b } = await signUp({ phone: victimPhone });
      expect((await b.me()).body).toMatchObject({ phone: victimPhone, phoneVerified: true, emailVerified: true });
    });

    it('a ticket for a phone that is now taken answers 409 phone_taken; a 400 does not use it', async () => {
      const phone = newPhone();
      const email = newEmail();
      const b = browser();
      const details = { fullName: 'דנה', phone, email, marketingConsent: false };
      await b.post('sign-up', details).expect(200);
      const signUpToken = await verifyBoth(b, phone, email);
      await b.post('sign-up', { ...details, fullName: 'א', signUpToken }).expect(400);
      await prisma.customer.create({ data: { fullName: 'קיים', phone, email: newEmail() } });
      await b
        .post('sign-up', { ...details, signUpToken })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('phone_taken'));
    });
  });

  describe('sign-in', () => {
    it('by e-mail and password', async () => {
      const { email } = await signUp({ password: 'correct horse 1' });
      const b = browser();
      const res = await b
        .post('sign-in', { email: ` ${email.toUpperCase()} `, password: 'correct horse 1' })
        .expect(200);
      expect(res.body.customer.email).toBe(email);
      expect((await b.me()).body.email).toBe(email);
    });

    it('a wrong password, an unknown e-mail and an account without a password answer the same 401', async () => {
      const { email } = await signUp({ password: 'correct horse 1' });
      const { email: noPassword } = await signUp();
      const b = browser();
      const wrong = await b.post('sign-in', { email, password: 'wrong horse 1' }).expect(401);
      const unknown = await b.post('sign-in', { email: newEmail(), password: 'wrong horse 1' }).expect(401);
      const none = await b.post('sign-in', { email: noPassword, password: 'wrong horse 1' }).expect(401);
      expect(wrong.body).toEqual({ statusCode: 401, code: 'invalid_credentials' });
      expect(unknown.body).toEqual(wrong.body);
      expect(none.body).toEqual(wrong.body);
      expect(customerCookie(wrong)).toBeUndefined();
    });

    it('after 5 wrong passwords the e-mail must wait, known or unknown alike', async () => {
      const { email } = await signUp({ password: 'correct horse 1' });
      const unknown = newEmail();
      const b = browser();
      for (const target of [email, unknown]) {
        for (let i = 0; i < 5; i++) await b.post('sign-in', { email: target, password: 'wrong horse 1' }).expect(401);
        const res = await b.post('sign-in', { email: target, password: 'correct horse 1' }).expect(429);
        expect(res.body.code).toBe('too_many_attempts');
        expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
      }
    });

    it('per-IP limit on sign-in answers 429', async () => {
      throttle.setLimit('signin', 2);
      try {
        const b = browser();
        await b.post('sign-in', { email: newEmail(), password: 'x' }).expect(401);
        await b.post('sign-in', { email: newEmail(), password: 'x' }).expect(401);
        await b.post('sign-in', { email: newEmail(), password: 'x' }).expect(429);
      } finally {
        throttle.setLimit('signin', 100_000);
      }
    });

    it('by SMS code, which also marks the phone verified', async () => {
      const { phone, email } = await signUp();
      const b = browser();
      await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202, { sent: true });
      const res = await b.post('otp/verify', { target: phone, code: smsCode(phone) }).expect(200);
      expect(res.body.customer).toMatchObject({ phone, email, phoneVerified: true });
      expect(customerCookie(res)).toBeDefined();
    });

    it('by e-mail code, which marks the e-mail verified', async () => {
      const { email } = await signUp();
      const b = browser();
      await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' }).expect(202);
      const res = await b.post('otp/verify', { target: email, code: emailCode(email) }).expect(200);
      expect(res.body.customer).toMatchObject({ email, emailVerified: true });
    });

    it('two parallel verifies of one code sign in only once', async () => {
      const { phone } = await signUp();
      await browser().post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202);
      const code = smsCode(phone);
      const results = await Promise.all([
        browser().post('otp/verify', { target: phone, code }),
        browser().post('otp/verify', { target: phone, code }),
      ]);
      expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 401]);
    });

    it('6 wrong codes: the right code no longer works', async () => {
      const { phone } = await signUp();
      const b = browser();
      await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202);
      const code = smsCode(phone)!;
      for (let i = 0; i < 6; i++)
        await b
          .post('otp/verify', { target: phone, code: wrongOf(code) })
          .expect(401)
          .expect((r) => expect(r.body.code).toBe('invalid_code'));
      await b.post('otp/verify', { target: phone, code }).expect(401);
    });

    it('a 4th code request for one target in 10 minutes still answers 202 but sends nothing', async () => {
      const phone = newPhone();
      const b = browser();
      for (let i = 0; i < 4; i++)
        await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202, { sent: true });
      expect(sentTo(phone)).toBe(3);
      expect(await prisma.otpCode.count({ where: { target: phone } })).toBe(3);
    });

    it('per-IP limit on code requests answers 429', async () => {
      throttle.setLimit('otp', 2);
      try {
        const b = browser();
        await b.post('otp/request', { target: newPhone(), channel: 'sms', purpose: 'sign_in' }).expect(202);
        await b.post('otp/request', { target: newPhone(), channel: 'sms', purpose: 'sign_in' }).expect(202);
        const res = await b.post('otp/request', { target: newPhone(), channel: 'sms', purpose: 'sign_in' }).expect(429);
        expect(res.headers['retry-after']).toBeDefined();
      } finally {
        throttle.setLimit('otp', 100_000);
      }
    });

    it('a code request answers identically for a known and an unknown e-mail', async () => {
      const { email } = await signUp();
      const unknown = newEmail();
      const b = browser();
      const before = sentTo(email); // the sign-up code
      const known = await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' });
      const other = await b.post('otp/request', { target: unknown, channel: 'email', purpose: 'sign_in' });
      expect(known.status).toBe(202);
      expect(other.status).toBe(known.status);
      expect(other.body).toEqual(known.body);
      expect(sentTo(email)).toBe(before + 1);
      expect(sentTo(unknown)).toBe(1);
    });

    it('a code request with a malformed target or channel answers 400', async () => {
      const b = browser();
      await b.post('otp/request', { target: 'nope', channel: 'sms', purpose: 'sign_in' }).expect(400);
      await b.post('otp/request', { target: newEmail(), channel: 'sms', purpose: 'sign_in' }).expect(400);
      await b.post('otp/request', { target: newPhone(), channel: 'fax', purpose: 'sign_in' }).expect(400);
      await b.post('otp/request', { target: newPhone(), channel: 'sms', purpose: 'reset_password' }).expect(400);
    });

    it('writes need the storefront origin', async () => {
      await request(app.getHttpServer() as App)
        .post('/api/account/otp/request')
        .send({ target: newPhone(), channel: 'sms', purpose: 'sign_in' })
        .expect(403);
    });
  });

  describe('session', () => {
    it('cookie hg_customer: httpOnly, SameSite=Lax, path /, 30 days; only the hash is stored', async () => {
      const { email } = await signUp({ password: 'correct horse 1' });
      const res = await browser().post('sign-in', { email, password: 'correct horse 1' }).expect(200);
      const cookie = customerCookie(res)!;
      expect(cookie).toMatch(/HttpOnly/i);
      expect(cookie).toMatch(/SameSite=Lax/i);
      expect(cookie).toMatch(/Path=\//);
      expect(cookie).toMatch(/Max-Age=2592000/);
      expect(cookie).not.toMatch(/Secure/i); // NODE_ENV is not production in e2e
      const token = tokenOf(cookie);
      expect(await prisma.customerSession.count({ where: { tokenHash: token } })).toBe(0);
      const session = await prisma.customerSession.findUniqueOrThrow({ where: { tokenHash: sha(token) } });
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    });

    it('signing in again from the same browser ends the session its cookie named', async () => {
      const { b, email, phone } = await signUp({ password: 'correct horse 1' });
      const customer = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      const before = await prisma.customerSession.findFirstOrThrow({ where: { customerId: customer.id } });
      await b.post('sign-in', { email, password: 'correct horse 1' }).expect(200);
      const sessions = await prisma.customerSession.findMany({ where: { customerId: customer.id } });
      expect(sessions).toHaveLength(1);
      expect(sessions[0].id).not.toBe(before.id);
      expect((await b.me()).body.phone).toBe(phone);
    });

    it('GET me answers 200 null when signed out, never cached', async () => {
      const res = await browser().me().expect(200);
      expect(res.body).toBeNull();
      expect(res.text).toBe('null');
      expect(res.headers['cache-control']).toBe('no-store');
      const forged = await request(app.getHttpServer() as App)
        .get('/api/account/me')
        .set('Cookie', `${COOKIE}=forged`)
        .expect(200);
      expect(forged.body).toBeNull();
    });

    it('renews the session at most once a day (sliding 30 days)', async () => {
      const { b, phone } = await signUp();
      const customer = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      const fresh = await b.me().expect(200);
      expect(customerCookie(fresh)).toBeUndefined();

      const old = new Date(Date.now() - 2 * DAY_MS);
      await prisma.customerSession.updateMany({
        where: { customerId: customer.id },
        data: { lastSeenAt: old, expiresAt: new Date(old.getTime() + 30 * DAY_MS) },
      });
      const renewed = await b.me().expect(200);
      expect(customerCookie(renewed)).toMatch(/Max-Age=2592000/);
      const session = await prisma.customerSession.findFirstOrThrow({ where: { customerId: customer.id } });
      expect(session.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * DAY_MS);
    });

    it('an expired session is signed out', async () => {
      const { b, phone } = await signUp();
      const customer = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      await prisma.customerSession.updateMany({
        where: { customerId: customer.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect((await b.me().expect(200)).body).toBeNull();
    });

    it('sign-out deletes the session and clears the cookie', async () => {
      const { b, phone } = await signUp();
      const customer = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      const res = await b.post('sign-out').expect(204);
      expect(customerCookie(res)).toMatch(/Expires=Thu, 01 Jan 1970/);
      expect(await prisma.customerSession.count({ where: { customerId: customer.id } })).toBe(0);
      expect((await b.me()).body).toBeNull();
    });

    it('account writes need a session', async () => {
      const b = browser();
      await b.post('password', { next: 'new password 1' }).expect(401);
      await b.post('contact/change', { kind: 'phone', value: newPhone() }).expect(401);
      await b.post('contact/confirm', { kind: 'phone', code: '123456' }).expect(401);
    });
  });

  describe('account changes', () => {
    it('changing the phone needs the code sent to the new phone', async () => {
      const { b, phone } = await signUp();
      const next = newPhone();
      await b.post('contact/change', { kind: 'phone', value: next }).expect(202, { sent: true });
      expect(sentTo(phone)).toBe(1); // only the sign-up code
      const code = smsCode(next)!;
      expect((await b.me()).body.phone).toBe(phone);

      await b
        .post('contact/confirm', { kind: 'phone', code: wrongOf(code) })
        .expect(401)
        .expect((r) => expect(r.body.code).toBe('invalid_code'));
      await b.post('contact/confirm', { kind: 'email', code }).expect(401);
      const res = await b.post('contact/confirm', { kind: 'phone', code }).expect(200);
      expect(res.body.customer).toMatchObject({ phone: next, phoneVerified: true });
    });

    it('changing the e-mail verifies the new one; a taken value answers 409', async () => {
      const { b } = await signUp();
      const { email: taken, phone: takenPhone } = await signUp();
      await b
        .post('contact/change', { kind: 'email', value: taken })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('email_taken'));
      await b
        .post('contact/change', { kind: 'phone', value: takenPhone })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('phone_taken'));
      const next = newEmail();
      await b.post('contact/change', { kind: 'email', value: next }).expect(202);
      const res = await b.post('contact/confirm', { kind: 'email', code: emailCode(next) }).expect(200);
      expect(res.body.customer).toMatchObject({ email: next, emailVerified: true });
    });

    it('confirming a new phone or e-mail signs out the other sessions', async () => {
      const { b, email } = await signUp();
      const other = browser();
      await other.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' }).expect(202);
      await other.post('otp/verify', { target: email, code: emailCode(email) }).expect(200);
      const next = newPhone();
      await b.post('contact/change', { kind: 'phone', value: next }).expect(202);
      await b.post('contact/confirm', { kind: 'phone', code: smsCode(next) }).expect(200);
      expect((await b.me()).body.phone).toBe(next);
      expect((await other.me()).body).toBeNull();
    });

    it('repeated 409s on contact change reach the per-IP code limit', async () => {
      const { b } = await signUp();
      const { phone: taken } = await signUp();
      throttle.setLimit('otp', 2);
      try {
        await b.post('contact/change', { kind: 'phone', value: taken }).expect(409);
        await b.post('contact/change', { kind: 'phone', value: taken }).expect(409);
        await b.post('contact/change', { kind: 'phone', value: taken }).expect(429);
      } finally {
        throttle.setLimit('otp', 100_000);
      }
    });

    it('setting a first password needs no current one; changing it does, and signs out the other sessions', async () => {
      const { b, email, phone } = await signUp();
      await b.post('password', { next: 'short' }).expect(400);
      await b.post('password', { next: 'first password 1' }).expect(200);
      expect((await b.me()).body.hasPassword).toBe(true);

      const other = browser();
      await other.post('sign-in', { email, password: 'first password 1' }).expect(200);
      await b
        .post('password', { next: 'second password 1' })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('wrong_password'));
      await b
        .post('password', { current: 'nope nope 1', next: 'second password 1' })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('wrong_password'));
      await b.post('password', { current: 'first password 1', next: 'second password 1' }).expect(200);

      expect((await b.me()).body.phone).toBe(phone);
      expect((await other.me()).body).toBeNull();
      await browser().post('sign-in', { email, password: 'second password 1' }).expect(200);
    });

    it('password reset goes through a code by e-mail and signs out every other session', async () => {
      const { b: old, email } = await signUp({ password: 'correct horse 1' });
      const unknown = newEmail();
      const b = browser();
      const sentBefore = sentTo(email);
      const known = await b.post('password/reset/request', { email }).expect(202);
      const other = await b.post('password/reset/request', { email: unknown }).expect(202);
      expect(other.body).toEqual(known.body);
      // The same store work for both; the e-mail goes out in the background, only to the account.
      expect(await prisma.otpCode.count({ where: { target: email, purpose: 'RESET_PASSWORD' } })).toBe(1);
      expect(await prisma.otpCode.count({ where: { target: unknown, purpose: 'RESET_PASSWORD' } })).toBe(1);
      await vi.waitFor(() => expect(sentTo(email)).toBe(sentBefore + 1));
      expect(sentTo(unknown)).toBe(0);
      const code = emailCode(email)!;

      await b
        .post('password/reset', { email, code: wrongOf(code), next: 'brand new pass 1' })
        .expect(401)
        .expect((r) => expect(r.body.code).toBe('invalid_code'));
      await b.post('password/reset', { email, code, next: 'short' }).expect(400);
      const res = await b.post('password/reset', { email, code, next: 'brand new pass 1' }).expect(200);
      expect(res.body.customer).toMatchObject({ email, emailVerified: true, hasPassword: true });
      expect(customerCookie(res)).toBeDefined();
      expect((await old.me()).body).toBeNull();
      await b.post('password/reset', { email, code, next: 'again new pass 1' }).expect(401);

      await browser().post('sign-in', { email, password: 'correct horse 1' }).expect(401);
      await browser().post('sign-in', { email, password: 'brand new pass 1' }).expect(200);
    });

    it('a failing e-mail provider does not change the reset answer', async () => {
      const { email } = await signUp();
      const b = browser();
      const unknown = await b.post('password/reset/request', { email: newEmail() }).expect(202);
      emailSpy.mockRejectedValueOnce(new Error('provider down'));
      const known = await b.post('password/reset/request', { email }).expect(202);
      expect(known.body).toEqual(unknown.body);
      await vi.waitFor(async () =>
        expect(await prisma.notificationLog.count({ where: { template: 'otp', status: 'FAILED' } })).toBeGreaterThan(0),
      );
    });

    it('a sign-in code does not reset a password', async () => {
      const { email } = await signUp({ password: 'correct horse 1' });
      const b = browser();
      await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' }).expect(202);
      await b.post('password/reset', { email, code: emailCode(email), next: 'brand new pass 1' }).expect(401);
    });
  });
});
