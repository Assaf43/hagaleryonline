import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter, UrlTree, type CanMatchFn, type PartialMatchRouteSnapshot } from '@angular/router';
import type { AdminMe } from '@hg/models';
import { AuthService } from './auth.service';
import { hasPermission, sessionExpiredInterceptor, signedIn, signedOut, superAdminOnly } from './guards';
import { IdleWatch } from './idle-watch';

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

describe('sessionExpiredInterceptor', () => {
  const noteActivity = vi.fn();
  let expired = false;
  const clear = vi.fn();
  let http: HttpTestingController;
  let client: HttpClient;
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    noteActivity.mockReset();
    clear.mockReset();
    expired = false;
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(withInterceptors([sessionExpiredInterceptor])),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { clear } },
        {
          provide: IdleWatch,
          useValue: {
            noteActivity,
            get expired() {
              return expired;
            },
          },
        },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    client = TestBed.inject(HttpClient);
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
  });

  it('counts a successful admin call as activity', () => {
    client.get('/api/admin/orders').subscribe();
    http.expectOne('/api/admin/orders').flush({});
    expect(noteActivity).toHaveBeenCalledTimes(1);
  });

  it('does not count logging out, failures or other APIs as activity', () => {
    client.post('/api/admin/auth/logout', {}).subscribe();
    http.expectOne('/api/admin/auth/logout').flush(null, { status: 204, statusText: 'No Content' });
    client.get('/api/orders').subscribe();
    http.expectOne('/api/orders').flush({});
    client.get('/api/admin/orders').subscribe({ error: () => undefined });
    http.expectOne('/api/admin/orders').flush({ code: 'boom' }, { status: 500, statusText: 'Server Error' });
    expect(noteActivity).not.toHaveBeenCalled();
  });

  it('sends a signed-out user to /login', () => {
    client.get('/api/admin/orders').subscribe({ error: () => undefined });
    http
      .expectOne('/api/admin/orders')
      .flush({ code: 'not_authenticated' }, { status: 401, statusText: 'Unauthorized' });
    expect(clear).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login');
  });

  it('sends a user whose idle time ran out to /login?reason=idle', () => {
    expired = true;
    client.get('/api/admin/orders').subscribe({ error: () => undefined });
    http
      .expectOne('/api/admin/orders')
      .flush({ code: 'not_authenticated' }, { status: 401, statusText: 'Unauthorized' });
    expect(navigate).toHaveBeenCalledWith('/login?reason=idle');
  });
});
