import { RequestMethod } from '@nestjs/common';
import { GUARDS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { AppModule } from './../src/app.module.js';
import { AllowPendingMfa, Public, RequirePermission, SuperAdminOnly } from './../src/auth/guards.js';
import { configureApp } from './../src/configure-app.js';

/**
 * OWASP A01 (spec 9a.2): every route's guards and admin flags, read from the Nest metadata of the real app. The rules
 * below fail on a route that is missing a guard; the file snapshot puts every new or changed route in front of review.
 */

/** Admin routes behind AdminAuthGuard that any signed-in admin may call (their own session or account). */
const SIGNED_IN_ONLY: Record<string, string> = {
  'GET /api/admin/auth/me': 'the signed-in admin reads their own profile and permissions',
  'POST /api/admin/auth/logout': "ends the caller's own session (also before 2FA)",
  'POST /api/admin/auth/logout-all': 'ends every session of the caller',
  'POST /api/admin/auth/password':
    'the caller changes their own password (decision 59); current password and a 2FA code required',
  'POST /api/admin/auth/2fa/setup': "the caller's own first 2FA enrolment (refused once 2FA is set up)",
  'POST /api/admin/auth/2fa/enable': "the caller's own first 2FA enrolment (refused once 2FA is set up)",
  'POST /api/admin/auth/2fa/verify': "the second sign-in step of the caller's own session",
};

/** Public writes without StorefrontOriginGuard: the caller is not the storefront, a signature is the check. */
const CROSS_SITE_WRITES: Record<string, string> = {
  'POST /api/payments/webhook': 'the payment provider calls it; HMAC signature over the raw body',
  'POST /api/marketing/webhook': 'the e-mail marketing tool calls it; signed webhook',
  'POST /api/internal/error-events':
    'the storefront server calls it; shared INTERNAL_API_TOKEN (constant-time), 404 for anyone else',
};

/** `/api/account/` routes reached before there is a session. */
const ACCOUNT_BEFORE_SIGN_IN: Record<string, string> = {
  'GET /api/account/me': 'answers 204 to a guest (OptionalCustomerGuard), so the storefront knows it is signed out',
  'POST /api/account/sign-out': 'clears the cookie whether or not the session is still valid (OptionalCustomerGuard)',
  'POST /api/account/sign-in': 'creates the session',
  'POST /api/account/sign-up': 'creates the account and its session',
  'POST /api/account/otp/request': 'the code that signs in or signs up',
  'POST /api/account/otp/verify': 'the code that signs in or signs up',
  'POST /api/account/password/reset/request': 'a forgotten password: no session by definition',
  'POST /api/account/password/reset': 'a forgotten password: no session by definition',
};

interface Route {
  method: string;
  path: string;
  guards: string[];
  public: boolean;
  pendingMfa: boolean;
  superAdmin: boolean;
  permission: string | undefined;
}

const PUBLIC_KEY = Public().KEY;
const PENDING_KEY = AllowPendingMfa().KEY;
const SUPER_KEY = SuperAdminOnly().KEY;
const PERMISSION_KEY = RequirePermission('orders.view').KEY;

const asList = (value: string | string[] | undefined): string[] =>
  value === undefined ? [''] : Array.isArray(value) ? value : [value];

const joinPath = (...parts: string[]): string => `/${parts.join('/')}`.replace(/\/+/g, '/').replace(/(.)\/$/, '$1');

const guardNames = (guards: unknown[] | undefined): string[] =>
  (guards ?? []).map((guard) =>
    typeof guard === 'function' ? guard.name : ((guard as object).constructor?.name ?? 'unknown'),
  );

function listRoutes(app: NestExpressApplication): Route[] {
  const discovery = app.get(DiscoveryService);
  const scanner = app.get(MetadataScanner);
  const reflector = app.get(Reflector);
  const routes: Route[] = [];
  for (const wrapper of discovery.getControllers()) {
    const controller = wrapper.metatype as (new (...args: never[]) => unknown) | null;
    if (!controller) continue;
    const classPaths = asList(Reflect.getMetadata(PATH_METADATA, controller) as string | string[] | undefined);
    const classGuards = guardNames(Reflect.getMetadata(GUARDS_METADATA, controller) as unknown[] | undefined);
    for (const name of scanner.getAllMethodNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[name] as (...args: unknown[]) => unknown;
      const methodPath = Reflect.getMetadata(PATH_METADATA, handler) as string | string[] | undefined;
      if (methodPath === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const guards = [
        ...classGuards,
        ...guardNames(Reflect.getMetadata(GUARDS_METADATA, handler) as unknown[] | undefined),
      ];
      const flag = <T>(key: string) => reflector.getAllAndOverride<T>(key, [handler, controller]);
      for (const base of classPaths)
        for (const sub of asList(methodPath))
          routes.push({
            method,
            path: joinPath('api', base, sub),
            guards,
            public: flag<boolean>(PUBLIC_KEY) === true,
            pendingMfa: flag<boolean>(PENDING_KEY) === true,
            superAdmin: flag<boolean>(SUPER_KEY) === true,
            permission: flag<string>(PERMISSION_KEY),
          });
    }
  }
  return routes.sort((a, b) => cmp(a.path, b.path) || cmp(a.method, b.method));
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const key = (route: Route) => `${route.method} ${route.path}`;

function accessLabel(route: Route): string {
  const labels: string[] = [];
  if (route.public) labels.push('public');
  if (route.superAdmin) labels.push('super admin');
  if (route.permission) labels.push(route.permission);
  if (route.pendingMfa) labels.push('pending 2FA ok');
  return labels.join(', ');
}

function table(routes: Route[]): string {
  const rows = routes.map(
    (route) => `| ${route.method} | ${route.path} | ${route.guards.join(', ')} | ${accessLabel(route)} |`,
  );
  return [
    '# API route guards (generated by apps/api/test/route-guards.e2e-spec.ts — review every change)',
    '',
    '| method | path | guards | permission |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

describe('API route guards (OWASP A01, e2e)', () => {
  let app: NestExpressApplication;
  let routes: Route[];

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule, DiscoveryModule] }).compile();
    app = configureApp(moduleRef.createNestApplication<NestExpressApplication>());
    await app.init();
    routes = listRoutes(app);
  });

  afterAll(async () => {
    await app.close();
  });

  it('finds the routes (sanity)', () => {
    expect(routes.length).toBeGreaterThan(100);
    expect(routes.map(key)).toContain('GET /api/health');
  });

  it('every /api/admin/ route has SameOriginGuard and AdminAuthGuard', () => {
    const missing = routes
      .filter((route) => route.path.startsWith('/api/admin/'))
      .filter((route) => !route.guards.includes('SameOriginGuard') || !route.guards.includes('AdminAuthGuard'))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('every route behind AdminAuthGuard is Public, Super Admin only, needs a permission, or is signed-in only', () => {
    const missing = routes
      .filter((route) => route.guards.includes('AdminAuthGuard'))
      .filter((route) => !route.public && !route.superAdmin && !route.permission && !(key(route) in SIGNED_IN_ONLY))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('every public write has StorefrontOriginGuard, or is a signed cross-site write', () => {
    const missing = routes
      .filter((route) => !route.guards.includes('AdminAuthGuard') && !['GET', 'HEAD'].includes(route.method))
      .filter((route) => !route.guards.includes('StorefrontOriginGuard') && !(key(route) in CROSS_SITE_WRITES))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('every /api/account/ route needs a customer session, except the ones reached before sign-in', () => {
    const missing = routes
      .filter((route) => route.path.startsWith('/api/account/'))
      .filter((route) => !route.guards.includes('CustomerSessionGuard') && !(key(route) in ACCOUNT_BEFORE_SIGN_IN))
      .map(key);
    expect(missing).toEqual([]);
  });

  it('the allow-lists name only routes that exist', () => {
    const all = new Set(routes.map(key));
    const stale = [SIGNED_IN_ONLY, CROSS_SITE_WRITES, ACCOUNT_BEFORE_SIGN_IN]
      .flatMap((list) => Object.keys(list))
      .filter((entry) => !all.has(entry));
    expect(stale).toEqual([]);
  });

  it('the route table matches the reviewed snapshot', async () => {
    await expect(table(routes)).toMatchFileSnapshot('__snapshots__/route-guards.md');
  });
});
