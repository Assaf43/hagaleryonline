import { PLATFORM_ID, inject } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router, type CanActivateFn } from '@angular/router';
import { CustomerStore } from './customer.store';

/**
 * Keeps the account pages for signed-in customers (ACC-01): a signed-out visitor goes to `/account?next=<this page>`
 * (the sign-in page accepts only a same-site path in `next`). The session is read in the browser only, so the server
 * lets the route through and renders a shell without any customer data.
 */
export const accountGuard: CanActivateFn = async (_route, state) => {
  if (!isPlatformBrowser(inject(PLATFORM_ID))) return true;
  const store = inject(CustomerStore);
  const router = inject(Router);
  await store.load();
  return store.me() ? true : router.createUrlTree(['/account'], { queryParams: { next: state.url } });
};
