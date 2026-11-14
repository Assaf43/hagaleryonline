import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Router, UrlTree, type ActivatedRouteSnapshot, type RouterStateSnapshot } from '@angular/router';
import { accountGuard } from './account.guard';
import { customerMe, provideAccountTesting } from './account.testing';

function run(url: string): Promise<boolean | UrlTree> {
  const state = { url } as RouterStateSnapshot;
  return TestBed.runInInjectionContext(() => accountGuard({} as ActivatedRouteSnapshot, state)) as Promise<
    boolean | UrlTree
  >;
}

describe('accountGuard', () => {
  it('sends a signed-out visitor to /account with ?next=', async () => {
    const http = provideAccountTesting();
    const result = run('/account/orders/100001');
    await Promise.resolve();
    http.expectOne('/api/account/me').flush(null);
    const tree = await result;
    expect(tree).toBeInstanceOf(UrlTree);
    expect(TestBed.inject(Router).serializeUrl(tree as UrlTree)).toBe('/account?next=%2Faccount%2Forders%2F100001');
  });

  it('lets a signed-in customer through', async () => {
    const http = provideAccountTesting();
    const result = run('/account/details');
    await Promise.resolve();
    http.expectOne('/api/account/me').flush(customerMe());
    expect(await result).toBe(true);
  });

  it('does not read the session on the server (the page renders only in the browser)', async () => {
    const http = provideAccountTesting([{ provide: PLATFORM_ID, useValue: 'server' }]);
    expect(await run('/account/details')).toBe(true);
    http.expectNone('/api/account/me');
  });
});
