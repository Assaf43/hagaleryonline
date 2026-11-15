import { vi, type MockInstance } from 'vitest';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { App } from 'supertest/types.js';
import { AppModule } from './../src/app.module.js';
import { configureApp } from './../src/configure-app.js';
import { CustomerOrigin } from './../src/generated/prisma/client.js';
import {
  EMAIL_PROVIDER,
  SMS_PROVIDER,
  type EmailProvider,
  type SmsProvider,
} from './../src/notifications/notification-provider.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ORIGIN = 'http://localhost:4200';
const DOMAIN = '@unverified.e2e.test';
const COOKIE = 'hg_customer';
const RELEASED = 'customer.email_released';

// Phase 6 §4.3 (decision 85): a store quick account has a verified phone and an unverified e-mail. That e-mail is no key
// to the account, and a website sign-up that verifies it takes it over. Codes are read from the mock providers' calls.
describe('Unverified e-mail (e2e, decision 85)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  let smsSpy: MockInstance<SmsProvider['sendSms']>;
  let emailSpy: MockInstance<EmailProvider['sendEmail']>;
  let seq = 0;
  const phones: string[] = [];

  const unique = () => String(++seq).padStart(4, '0') + String(Date.now() % 10_000).padStart(4, '0');
  const newPhone = () => {
    const phone = `05${unique()}`;
    phones.push(phone);
    return phone;
  };
  const newEmail = () => `user${unique()}${DOMAIN}`;

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
  const emailsTo = (to: string) => emailSpy.mock.calls.filter(([m]) => m.to === to).length;
  const customerCookie = (res: request.Response) =>
    ([res.headers['set-cookie'] ?? []].flat() as string[]).find((c) => c.startsWith(`${COOKIE}=`));

  /** A store quick account: phone verified, e-mail (or none) unverified, created through Prisma. */
  const quickAccount = (opts: { email?: string | null; password?: string } = {}) =>
    prisma.customer.create({
      data: {
        fullName: 'לקוח חנות',
        phone: newPhone(),
        email: opts.email === undefined ? newEmail() : opts.email,
        phoneVerifiedAt: new Date(),
        emailVerifiedAt: null,
        createdVia: CustomerOrigin.STORE,
      },
    });

  /** Signs in by an SMS code to the phone (the only key of a quick account). */
  const signInByPhone = async (phone: string) => {
    const b = browser();
    await b.post('otp/request', { target: phone, channel: 'sms', purpose: 'sign_in' }).expect(202);
    const res = await b.post('otp/verify', { target: phone, code: smsCode(phone) }).expect(200);
    expect(customerCookie(res)).toBeDefined();
    return b;
  };

  /** A website sign-up with both codes; returns the response of the final step. */
  const websiteSignUp = async (phone: string, email: string) => {
    const b = browser();
    const details = { fullName: 'דנה לוי', phone, email, marketingConsent: false };
    await b.post('sign-up', details).expect(200, { verify: true });
    const first = await b.post('otp/verify', { target: phone, code: smsCode(phone), purpose: 'sign_up' }).expect(200);
    const second = await b
      .post('otp/verify', {
        target: email,
        code: emailCode(email),
        purpose: 'sign_up',
        signUpToken: first.body.signUpToken,
      })
      .expect(200);
    return b.post('sign-up', { ...details, signUpToken: second.body.signUpToken });
  };

  const cleanup = async () => {
    const ids = (
      await prisma.customer.findMany({
        where: { OR: [{ email: { endsWith: DOMAIN } }, { phone: { in: phones } }] },
        select: { id: true },
      })
    ).map((c) => c.id);
    await prisma.auditLog.deleteMany({ where: { action: RELEASED, entityId: { in: ids } } });
    await prisma.otpCode.deleteMany({});
    await prisma.customer.deleteMany({ where: { id: { in: ids } } });
  };

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
    smsSpy = vi.spyOn(app.get<SmsProvider>(SMS_PROVIDER), 'sendSms');
    emailSpy = vi.spyOn(app.get<EmailProvider>(EMAIL_PROVIDER), 'sendEmail');
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
  });

  describe('unverified e-mail is not a key', () => {
    it('an e-mail sign-in code continues to sign-up, exactly as for an unknown e-mail', async () => {
      const quick = await quickAccount();
      const email = quick.email!;
      const unknown = newEmail();
      const b = browser();
      for (const target of [email, unknown]) {
        await b.post('otp/request', { target, channel: 'email', purpose: 'sign_in' }).expect(202, { sent: true });
      }
      const res = await b.post('otp/verify', { target: email, code: emailCode(email) }).expect(200);
      const other = await b.post('otp/verify', { target: unknown, code: emailCode(unknown) }).expect(200);
      expect(customerCookie(res)).toBeUndefined();
      expect(res.body).toMatchObject({ needsSignUp: true, verified: { phone: null, email } });
      expect(Object.keys(res.body).sort()).toEqual(Object.keys(other.body).sort());
      expect((await b.me()).body).toBeNull();
      // The code does not verify the quick account's e-mail either.
      const after = await prisma.customer.findUniqueOrThrow({ where: { id: quick.id } });
      expect(after.emailVerifiedAt).toBeNull();
    });

    it('e-mail + password answers the unknown-account error, even with the right password', async () => {
      const quick = await quickAccount();
      // A password set on the account (e.g. later from the account page) still does not open it by e-mail.
      const b = await signInByPhone(quick.phone);
      await b.post('password', { next: 'correct horse 1' }).expect(200);
      const known = await browser().post('sign-in', { email: quick.email, password: 'correct horse 1' }).expect(401);
      const unknown = await browser().post('sign-in', { email: newEmail(), password: 'correct horse 1' }).expect(401);
      expect(known.body).toEqual({ statusCode: 401, code: 'invalid_credentials' });
      expect(known.body).toEqual(unknown.body);
      expect(customerCookie(known)).toBeUndefined();
    });

    it('a password reset request answers the same, sends nothing and the reset cannot be completed', async () => {
      const quick = await quickAccount();
      const email = quick.email!;
      const b = browser();
      const known = await b.post('password/reset/request', { email }).expect(202);
      const unknown = await b.post('password/reset/request', { email: newEmail() }).expect(202);
      expect(known.body).toEqual(unknown.body);
      expect(await prisma.otpCode.count({ where: { customerId: quick.id } })).toBe(0);
      // The same store work as for an unknown e-mail: one undelivered code, no message.
      expect(await prisma.otpCode.count({ where: { target: email, purpose: 'RESET_PASSWORD' } })).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(emailsTo(email)).toBe(0);
      const res = await b.post('password/reset', { email, code: '123456', next: 'brand new pass 1' }).expect(401);
      expect(res.body.code).toBe('invalid_code');
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: quick.id } })).passwordHash).toBeNull();
    });

    it('the phone still signs in; /me shows the e-mail as unverified', async () => {
      const quick = await quickAccount();
      const b = await signInByPhone(quick.phone);
      expect((await b.me()).body).toMatchObject({ email: quick.email, emailVerified: false, phoneVerified: true });
    });
  });

  describe('verified sign-up releases the e-mail', () => {
    it('a website sign-up with that e-mail succeeds; the store account loses it, audited', async () => {
      const quick = await quickAccount();
      const email = quick.email!;
      const res = await websiteSignUp(newPhone(), email);
      expect(res.status).toBe(200);
      expect(res.body.customer).toMatchObject({ email, emailVerified: true });
      expect(customerCookie(res)).toBeDefined();

      const old = await prisma.customer.findUniqueOrThrow({ where: { id: quick.id } });
      expect(old.email).toBeNull();
      const audit = await prisma.auditLog.findMany({ where: { action: RELEASED, entityId: quick.id } });
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({ actorId: null, entityType: 'customer', before: null });
      expect(audit[0].after).toEqual({ customerId: quick.id });

      // The store account still signs in by phone, now without an e-mail.
      const b = await signInByPhone(quick.phone);
      expect((await b.me()).body).toMatchObject({ email: null, emailVerified: false });
    });

    it('a verified e-mail still blocks sign-up; a phone held by any account too', async () => {
      const email = newEmail();
      const phone = newPhone();
      expect((await websiteSignUp(phone, email)).status).toBe(200);
      await browser()
        .post('sign-up', { fullName: 'דנה לוי', phone: newPhone(), email })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('email_taken'));

      const quick = await quickAccount();
      await browser()
        .post('sign-up', { fullName: 'דנה לוי', phone: quick.phone, email: newEmail() })
        .expect(409)
        .expect((r) => expect(r.body.code).toBe('phone_taken'));
      expect((await prisma.customer.findUniqueOrThrow({ where: { id: quick.id } })).email).not.toBeNull();
    });
  });

  describe('verify own e-mail later', () => {
    it('signed in by phone, contact/change + contact/confirm on the same e-mail verifies it', async () => {
      const quick = await quickAccount();
      const b = await signInByPhone(quick.phone);
      await b.post('contact/change', { kind: 'email', value: quick.email }).expect(202, { sent: true });
      const res = await b.post('contact/confirm', { kind: 'email', code: emailCode(quick.email!) }).expect(200);
      expect(res.body.customer).toMatchObject({ email: quick.email, emailVerified: true });
      expect((await b.me()).body).toMatchObject({ email: quick.email, emailVerified: true });
      // Now it is a key: an e-mail code signs in.
      const other = browser();
      await other.post('otp/request', { target: quick.email, channel: 'email', purpose: 'sign_in' }).expect(202);
      const signedIn = await other.post('otp/verify', { target: quick.email, code: emailCode(quick.email!) });
      expect(signedIn.status).toBe(200);
      expect(customerCookie(signedIn)).toBeDefined();
    });
  });

  describe('add e-mail', () => {
    it('an account without an e-mail adds one through the same pair', async () => {
      const quick = await quickAccount({ email: null });
      const b = await signInByPhone(quick.phone);
      expect((await b.me()).body).toMatchObject({ email: null, emailVerified: false });
      const email = newEmail();
      await b.post('contact/change', { kind: 'email', value: email }).expect(202);
      const res = await b.post('contact/confirm', { kind: 'email', code: emailCode(email) }).expect(200);
      expect(res.body.customer).toMatchObject({ email, emailVerified: true });
    });
  });
});
