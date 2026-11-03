import type { NestExpressApplication } from '@nestjs/platform-express';
import { Secret, TOTP } from 'otpauth';
import request from 'supertest';
import type { OneTimeLink, TotpSetup } from '@hg/models';
import { AdminUsersService } from './../src/auth/admin-users.service.js';

export const ORIGIN = 'http://localhost:4300';

/** A browser on the admin app: keeps cookies and always sends the admin app's Origin. */
export function adminBrowser(app: NestExpressApplication) {
  const agent = request.agent(app.getHttpServer());
  const call = (method: 'get' | 'post' | 'patch' | 'put' | 'delete') => (url: string, body?: object) =>
    agent[method](`/api/admin${url}`).set('Origin', ORIGIN).send(body);
  return {
    agent,
    get: call('get'),
    post: call('post'),
    patch: call('patch'),
    put: call('put'),
    delete: call('delete'),
  };
}
export type AdminBrowser = ReturnType<typeof adminBrowser>;

/** Accepts an invite link, then signs in and sets up 2FA. */
export async function acceptAndSignIn(
  app: NestExpressApplication,
  user: { email: string; password: string },
  link: OneTimeLink,
): Promise<AdminBrowser> {
  await adminBrowser(app)
    .post(`/links/${link.url.split('/').pop()}`, { password: user.password })
    .expect(204);
  const b = adminBrowser(app);
  await b.post('/auth/login', { email: user.email, password: user.password }).expect(200);
  const setup = (await b.post('/auth/2fa/setup').expect(200)).body as TotpSetup;
  const code = new TOTP({ secret: Secret.fromBase32(setup.secret) }).generate();
  await b.post('/auth/2fa/enable', { code }).expect(200);
  return b;
}

/** The Super Admin (from the CLI) and one more user with the given template, both signed in. */
export async function signInOwnerAnd(app: NestExpressApplication, template: string) {
  const owner = { email: 'owner@example.test', password: 'olive sofa sunset window' };
  const other = { email: `${template}@example.test`, password: 'terracotta lamp quiet river' };
  const ownerBrowser = await acceptAndSignIn(
    app,
    owner,
    await app.get(AdminUsersService).createSuperAdmin(owner.email, 'בעלת העסק'),
  );
  const created = await ownerBrowser.post('/users', { email: other.email, name: 'עורך תוכן', template }).expect(201);
  return { owner: ownerBrowser, other: await acceptAndSignIn(app, other, created.body.invite as OneTimeLink) };
}
