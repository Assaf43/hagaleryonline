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

  /** Signs up by phone code; returns the signed-in browser. */
  const signUp = async (opts: { password?: string; marketingConsent?: boolean } = {}) => {
    const phone = newPhone();
    const email = newEmail();
    const b = browser();
    const details = {
      fullName: 'דנה לוי',
      email,
      password: opts.password,
      marketingConsent: opts.marketingConsent ?? false,
    };
    await b.post('sign-up', { ...details, phone }).expect(200, { verify: true });
    await b.post('otp/verify', { target: phone, code: smsCode(phone), purpose: 'sign_up', ...details }).expect(200);
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

  describe('sign-up', () => {
    it('by phone code: a code goes to the phone, the account is created only when it is entered', async () => {
      const phone = newPhone();
      const email = newEmail();
      const b = browser();
      const details = { fullName: '  דנה לוי ', email, password: 'correct horse 1', marketingConsent: true };
      await b.post('sign-up', { ...details, phone: `+972-${phone.slice(1)}` }).expect(200, { verify: true });
      expect(await prisma.customer.count({ where: { phone } })).toBe(0);
      const code = smsCode(phone);
      expect(code).toMatch(/^\d{6}$/);

      await b.post('otp/verify', { target: phone, code: wrongOf(code!), purpose: 'sign_up', ...details }).expect(401);
      const res = await b.post('otp/verify', { target: phone, code, purpose: 'sign_up', ...details }).expect(200);
      const me = (res.body as { customer: CustomerMe }).customer;
      expect(me).toMatchObject({
        fullName: 'דנה לוי',
        phone,
        email,
        phoneVerified: true,
        emailVerified: false,
        hasPassword: true,
        marketingConsent: true,
      });
      expect(customerCookie(res)).toBeDefined();
      expect((await b.me().expect(200)).body).toEqual(me);

      const row = await prisma.customer.findUniqueOrThrow({ where: { phone } });
      expect(row.passwordHash).toMatch(/^\$argon2id\$/);
      expect(row.marketingConsentSource).toBe(MarketingConsentSource.SIGNUP);
      expect(row.marketingConsentAt).not.toBeNull();
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

    it('a code entered for an unknown phone leads to sign-up with a single-use ticket', async () => {
      const phone = newPhone();
      const email = newEmail();
      const b = browser();
      await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202, { sent: true });
      const res = await b.post('otp/verify', { target: phone, code: smsCode(phone) }).expect(200);
      expect(res.body.needsSignUp).toBe(true);
      const signUpToken = res.body.signUpToken as string;
      expect(customerCookie(res)).toBeUndefined();

      // The ticket is bound to the verified phone.
      await b
        .post('sign-up', { signUpToken, fullName: 'דנה', phone: newPhone(), email, marketingConsent: false })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('invalid_token'));

      const done = await b
        .post('sign-up', { signUpToken, fullName: 'דנה', phone, email, marketingConsent: false })
        .expect(200);
      expect(done.body.customer).toMatchObject({ phone, email, phoneVerified: true, emailVerified: false });
      expect(customerCookie(done)).toBeDefined();
      await b
        .post('sign-up', { signUpToken, fullName: 'דנה', phone, email: newEmail(), marketingConsent: false })
        .expect(400)
        .expect((r) => expect(r.body.code).toBe('invalid_token'));
    });

    it('a ticket from an e-mail code verifies the e-mail', async () => {
      const email = newEmail();
      const b = browser();
      await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' }).expect(202);
      const res = await b.post('otp/verify', { target: email, code: emailCode(email) }).expect(200);
      const done = await b
        .post('sign-up', {
          signUpToken: res.body.signUpToken,
          fullName: 'דנה',
          phone: newPhone(),
          email,
          marketingConsent: false,
        })
        .expect(200);
      expect(done.body.customer).toMatchObject({ emailVerified: true, phoneVerified: false });
    });

    it('a ticket for a phone that is now taken answers 409 phone_taken', async () => {
      const phone = newPhone();
      const b = browser();
      await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202);
      const { body } = await b.post('otp/verify', { target: phone, code: smsCode(phone) }).expect(200);
      await browser()
        .post('sign-up', {
          signUpToken: body.signUpToken,
          fullName: 'א',
          phone,
          email: newEmail(),
          marketingConsent: false,
        })
        .expect(400); // fullName too short: the ticket is not used
      await prisma.customer.create({ data: { fullName: 'קיים', phone, email: newEmail() } });
      await b
        .post('sign-up', {
          signUpToken: body.signUpToken,
          fullName: 'דנה',
          phone,
          email: newEmail(),
          marketingConsent: false,
        })
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
      const known = await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' });
      const other = await b.post('otp/request', { target: unknown, channel: 'email', purpose: 'sign_in' });
      expect(known.status).toBe(202);
      expect(other.status).toBe(known.status);
      expect(other.body).toEqual(known.body);
      expect(sentTo(email)).toBe(1);
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
      const known = await b.post('password/reset/request', { email }).expect(202);
      const other = await b.post('password/reset/request', { email: unknown }).expect(202);
      expect(other.body).toEqual(known.body);
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

    it('a sign-in code does not reset a password', async () => {
      const { email } = await signUp({ password: 'correct horse 1' });
      const b = browser();
      await b.post('otp/request', { target: email, channel: 'email', purpose: 'sign_in' }).expect(202);
      await b.post('password/reset', { email, code: emailCode(email), next: 'brand new pass 1' }).expect(401);
    });
  });
});
