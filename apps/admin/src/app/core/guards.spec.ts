import { TestBed } from '@angular/core/testing';
import { provideRouter, UrlTree, type CanMatchFn, type PartialMatchRouteSnapshot } from '@angular/router';
import type { AdminMe } from '@hg/models';
import { AuthService } from './auth.service';
import { hasPermission, signedIn, signedOut, superAdminOnly } from './guards';

/** The user the fake AuthService resolves to; null = signed out. */
let me: Partial<AdminMe> | null = null;

/** Runs a guard the way the router does, against an AuthService that resolves to `me`. */
function runGuard(guard: CanMatchFn, user: Partial<AdminMe> | null) {
  me = user;
  return TestBed.runInInjectionContext(() => guard({}, [], {} as PartialMatchRouteSnapshot));
}

async function redirectOf(guard: CanMatchFn, me: Partial<AdminMe> | null) {
  const result = await runGuard(guard, me);
  expect(result).toBeInstanceOf(UrlTree);
  return (result as UrlTree).toString();
}

const admin: Partial<AdminMe> = { isSuperAdmin: false, permissions: [] };

describe('admin guards', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: AuthService, useValue: { load: () => Promise.resolve(me) } }],
    });
  });

  it('signedIn sends a signed-out visitor to /login', async () => {
    expect(await redirectOf(signedIn, null)).toBe('/login');
  });

  it('signedIn lets a signed-in user through', async () => {
    expect(await runGuard(signedIn, admin)).toBe(true);
  });

  it('signedOut sends a signed-in user home', async () => {
    expect(await redirectOf(signedOut, admin)).toBe('/');
  });

  it('signedOut lets a signed-out visitor see the login page', async () => {
    expect(await runGuard(signedOut, null)).toBe(true);
  });

  it('superAdminOnly sends anyone else home', async () => {
    expect(await redirectOf(superAdminOnly, null)).toBe('/');
    expect(await redirectOf(superAdminOnly, admin)).toBe('/');
    expect(await runGuard(superAdminOnly, { ...admin, isSuperAdmin: true })).toBe(true);
  });

  it('hasPermission sends a user without the permission home', async () => {
    const guard = hasPermission('catalog.edit');
    expect(await redirectOf(guard, null)).toBe('/');
    expect(await redirectOf(guard, admin)).toBe('/');
    expect(await runGuard(guard, { ...admin, permissions: ['catalog.edit'] })).toBe(true);
  });
});
