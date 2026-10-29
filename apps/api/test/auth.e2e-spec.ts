import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { AdminMe, AdminUserRow, AuditPage, OneTimeLink, RecoveryCodes, TotpSetup } from '@hg/models';
import { AppModule } from './../src/app.module.js';
import { AdminUsersService } from './../src/auth/admin-users.service.js';
import { configureApp } from './../src/configure-app.js';
import { PrismaService } from './../src/prisma/prisma.service.js';

const ORIGIN = 'http://localhost:4300';
const SUPER = { email: 'owner@example.test', name: 'בעל העסק', password: 'olive sofa sunset window' };
const EDITOR = { email: 'editor@example.test', name: 'עורכת תוכן', password: 'terracotta lamp quiet river' };

/** Admin auth end to end (decisions 48–55, 59), on the e2e test database. */
describe('Admin auth (e2e)', () => {
  let app: NestExpressApplication;
  let prisma: PrismaService;
  const secrets = new Map<string, string>();
  const codeFor = (email: string) => new TOTP({ secret: Secret.fromBase32(secrets.get(email)!) }).generate();

  /** A browser: keeps cookies and always sends the admin app's Origin. */
  const browser = () => {
    const agent = request.agent(app.getHttpServer());
    const call = (method: 'get' | 'post' | 'patch') => (url: string, body?: object) =>
      agent[method](`/api/admin${url}`).set('Origin', ORIGIN).send(body);
    return { get: call('get'), post: call('post'), patch: call('patch') };
  };
  type Browser = ReturnType<typeof browser>;

  const tokenOf = (link: OneTimeLink) => link.url.split('/').pop()!;
  const acceptLink = (link: OneTimeLink, password: string) =>
    browser()
      .post(`/links/${tokenOf(link)}`, { password })
      .expect(204);

  /** Password, then 2FA (setting it up the first time). Returns the recovery codes when 2FA was just enabled. */
  async function signIn(b: Browser, user: { email: string; password: string }, remember = false) {
    const login = await b
      .post('/auth/login', { email: user.email, password: user.password, rememberDevice: remember })
      .expect(200);
    if (login.body.step === 'setup-2fa') {
      const setup = (await b.post('/auth/2fa/setup').expect(200)).body as TotpSetup;
      secrets.set(user.email, setup.secret);
      return ((await b.post('/auth/2fa/enable', { code: codeFor(user.email) }).expect(200)).body as RecoveryCodes)
        .recoveryCodes;
    }
    await b.post('/auth/2fa/verify', { code: codeFor(user.email) }).expect(200);
    return [];
  }

  const owner = () => browser();
  let ownerBrowser: Browser;
  let editorId: number;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates the one Super Admin from the CLI and refuses a second', async () => {
    const users = app.get(AdminUsersService);
    const link = await users.createSuperAdmin(SUPER.email, SUPER.name);
    expect(link.url).toMatch(/^http:\/\/localhost:4300\/invite\/[\w-]{43}$/);
    await expect(users.createSuperAdmin('other@example.test', 'אחר')).rejects.toThrow('already exists');

    expect(
      (
        await browser()
          .get(`/links/${tokenOf(link)}`)
          .expect(200)
      ).body,
    ).toEqual({ type: 'invite', email: SUPER.email, name: SUPER.name });
    const weak = await browser()
      .post(`/links/${tokenOf(link)}`, { password: '123456789012' })
      .expect(400);
    expect(weak.body).toMatchObject({ code: 'weak_password', reason: 'too_common' });
    await acceptLink(link, SUPER.password);
    await browser()
      .post(`/links/${tokenOf(link)}`, { password: SUPER.password })
      .expect(410);
  });

  it('rejects wrong passwords and unknown e-mails with the same error', async () => {
    const wrong = await browser()
      .post('/auth/login', { email: SUPER.email, password: 'not the password at all' })
      .expect(401);
    const unknown = await browser()
      .post('/auth/login', { email: 'nobody@example.test', password: 'whatever whatever' })
      .expect(401);
    expect(wrong.body.code).toBe('invalid_credentials');
    expect(unknown.body.code).toBe('invalid_credentials');
    await prisma.adminUser.update({
      where: { email: SUPER.email },
      data: { failedLogins: 0, loginBlockedUntil: null },
    });
  });

  it('requires 2FA setup on first login before anything else (decision 51)', async () => {
    const b = browser();
    expect((await b.post('/auth/login', { email: SUPER.email, password: SUPER.password }).expect(200)).body.step).toBe(
      'setup-2fa',
    );
    expect((await b.get('/auth/me').expect(401)).body.code).toBe('mfa_required');

    const setup = (await b.post('/auth/2fa/setup').expect(200)).body as TotpSetup;
    expect(setup.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.otpauthUrl).toContain('otpauth://totp/');
    secrets.set(SUPER.email, setup.secret);
    expect((await b.post('/auth/2fa/enable', { code: '000000' }).expect(401)).body.code).toBe('invalid_code');

    const { recoveryCodes } = (await b.post('/auth/2fa/enable', { code: codeFor(SUPER.email) }).expect(200))
      .body as RecoveryCodes;
    expect(recoveryCodes).toHaveLength(10);
    const me = (await b.get('/auth/me').expect(200)).body as AdminMe;
    expect(me).toMatchObject({ email: SUPER.email, isSuperAdmin: true });
    expect(me.permissions).toContain('audit.view');
    ownerBrowser = b;
  });

  it('blocks state-changing requests from another origin (CSRF)', async () => {
    await request(app.getHttpServer())
      .post('/api/admin/auth/login')
      .send({ email: SUPER.email, password: SUPER.password })
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/admin/auth/login')
      .set('Origin', 'https://evil.example')
      .send({ email: SUPER.email, password: SUPER.password })
      .expect(403);
  });

  it('lets the Super Admin invite a content editor with one permission added (decisions 49, 52)', async () => {
    const created = await ownerBrowser
      .post('/users', {
        email: EDITOR.email,
        name: EDITOR.name,
        template: 'content_editor',
        extraPermissions: ['audit.view'],
      })
      .expect(201);
    const { user, invite } = created.body as { user: AdminUserRow; invite: OneTimeLink };
    editorId = user.id;
    expect(user).toMatchObject({ status: 'invited', template: 'content_editor' });
    expect(user.permissions).toEqual([
      'catalog.view',
      'catalog.edit',
      'catalog.import',
      'media.manage',
      'content.manage',
      'audit.view',
    ]);
    await ownerBrowser.post('/users', { email: EDITOR.email, name: 'x', template: 'manager' }).expect(409);

    await acceptLink(invite, EDITOR.password);
    const editor = browser();
    await signIn(editor, EDITOR);
    await editor.get('/users').expect(403);
    await editor.patch(`/users/${editorId}`, { template: 'manager' }).expect(403);
    await editor.get('/audit').expect(200);
  });

  it('removes a permission and the change shows up immediately', async () => {
    const editor = browser();
    await signIn(editor, EDITOR);
    await ownerBrowser
      .patch(`/users/${editorId}`, { removedPermissions: ['audit.view'], extraPermissions: [] })
      .expect(200);
    await editor.get('/audit').expect(403);
  });

  it('records who changed what in the audit log (decision 54)', async () => {
    const page = (await ownerBrowser.get(`/audit?entityType=admin_user&entityId=${editorId}`).expect(200))
      .body as AuditPage;
    const actions = page.items.map((i) => i.action);
    expect(actions).toEqual(
      expect.arrayContaining(['user.create', 'user.invite_accepted', 'auth.2fa_enabled', 'auth.login', 'user.update']),
    );
    const update = page.items.find((i) => i.action === 'user.update')!;
    expect(update.actor?.name).toBe(SUPER.name);
    expect(update.before).toMatchObject({ extraPermissions: ['audit.view'] });
    expect(update.after).toMatchObject({ removedPermissions: ['audit.view'] });
    expect(JSON.stringify(page)).not.toMatch(/argon2|passwordHash|password_hash|totpSecret|totp_secret|codeHash/i);
  });

  it('accepts each recovery code once', async () => {
    const b = browser();
    await b.post('/auth/login', { email: EDITOR.email, password: EDITOR.password }).expect(200);
    await prisma.adminUser.update({ where: { id: editorId }, data: { totpEnabledAt: null, totpSecretEnc: null } });
    const fresh = browser();
    const codes = await signIn(fresh, EDITOR);
    expect(codes).toHaveLength(10);

    const first = browser();
    await first.post('/auth/login', { email: EDITOR.email, password: EDITOR.password }).expect(200);
    await first.post('/auth/2fa/verify', { recoveryCode: codes[0].toUpperCase() }).expect(200);
    await first.get('/auth/me').expect(200);

    const again = browser();
    await again.post('/auth/login', { email: EDITOR.email, password: EDITOR.password }).expect(200);
    await again.post('/auth/2fa/verify', { recoveryCode: codes[0] }).expect(401);
    await prisma.adminUser.update({ where: { id: editorId }, data: { failedLogins: 0, loginBlockedUntil: null } });
  });

  it('ends a session after 8 idle hours, unless the device is remembered (decision 53)', async () => {
    const normal = browser();
    await signIn(normal, EDITOR);
    const remembered = browser();
    await signIn(remembered, EDITOR, true);
    const nineHoursAgo = new Date(Date.now() - 9 * 60 * 60_000);
    await prisma.adminSession.updateMany({ where: { userId: editorId }, data: { lastSeenAt: nineHoursAgo } });
    await normal.get('/auth/me').expect(401);
    await remembered.get('/auth/me').expect(200);
  });

  it('makes the next attempt wait after 5 failures, without locking the account for good (decision 59)', async () => {
    const b = browser();
    for (let i = 0; i < 5; i++)
      await b.post('/auth/login', { email: EDITOR.email, password: `wrong password ${i}` }).expect(401);
    const blocked = await b.post('/auth/login', { email: EDITOR.email, password: EDITOR.password }).expect(429);
    expect(blocked.body).toMatchObject({ code: 'too_many_attempts', retryAfterSeconds: 30 });

    await prisma.adminUser.update({
      where: { id: editorId },
      data: { loginBlockedUntil: new Date(Date.now() - 1000) },
    });
    await b.post('/auth/login', { email: EDITOR.email, password: EDITOR.password }).expect(200);
    await prisma.adminUser.update({ where: { id: editorId }, data: { failedLogins: 0, loginBlockedUntil: null } });
  });

  it('resets a password only through a link the user follows, and logs them out elsewhere (decision 59)', async () => {
    const before = browser();
    await signIn(before, EDITOR);
    const link = (await ownerBrowser.post(`/users/${editorId}/reset-password`).expect(200)).body as OneTimeLink;
    expect(link.url).toContain('/reset-password/');
    const newPassword = 'walnut sideboard morning tea';
    await acceptLink(link, newPassword);
    await before.get('/auth/me').expect(401);
    EDITOR.password = newPassword;
    await signIn(browser(), EDITOR);
  });

  it('changes one’s own password with the current password and a code, keeping only this session', async () => {
    const here = browser();
    await signIn(here, EDITOR);
    const elsewhere = browser();
    await signIn(elsewhere, EDITOR);
    const next = 'boucle armchair evening light';
    await here
      .post('/auth/password', { currentPassword: EDITOR.password, newPassword: next, code: '000000' })
      .expect(401);
    await prisma.adminUser.update({ where: { id: editorId }, data: { failedLogins: 0, loginBlockedUntil: null } });
    await here
      .post('/auth/password', { currentPassword: EDITOR.password, newPassword: next, code: codeFor(EDITOR.email) })
      .expect(204);
    await here.get('/auth/me').expect(200);
    await elsewhere.get('/auth/me').expect(401);
    EDITOR.password = next;
  });

  it('disabling a user ends their sessions; the Super Admin cannot be edited', async () => {
    const editor = browser();
    await signIn(editor, EDITOR);
    await ownerBrowser.patch(`/users/${editorId}`, { status: 'disabled' }).expect(200);
    await editor.get('/auth/me').expect(401);
    await browser().post('/auth/login', { email: EDITOR.email, password: EDITOR.password }).expect(401);

    const superId = (await prisma.adminUser.findUniqueOrThrow({ where: { email: SUPER.email } })).id;
    await ownerBrowser.patch(`/users/${superId}`, { status: 'disabled' }).expect(400);
  });

  it('resets 2FA from the server CLI, so it is set up again at the next login (decision 51)', async () => {
    await app.get(AdminUsersService).resetTwoFactorByEmail(SUPER.email);
    await ownerBrowser.get('/auth/me').expect(401);
    const b = owner();
    expect((await b.post('/auth/login', { email: SUPER.email, password: SUPER.password }).expect(200)).body.step).toBe(
      'setup-2fa',
    );
  });
});
