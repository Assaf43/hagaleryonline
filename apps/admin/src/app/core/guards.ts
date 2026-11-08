import { inject } from '@angular/core';
import { HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Router, type CanMatchFn } from '@angular/router';
import { catchError, throwError } from 'rxjs';
import type { Permission } from '@hg/models';
import { AuthService } from './auth.service';

// inject() works only before the first `await`, so every guard takes what it needs up front.

/** Signed-in screens: otherwise to the login page. */
export const signedIn: CanMatchFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return (await auth.load()) ? true : router.parseUrl('/login');
};

/** Login screens: a signed-in user goes straight in. */
export const signedOut: CanMatchFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return (await auth.load()) ? router.parseUrl('/') : true;
};

export const superAdminOnly: CanMatchFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return (await auth.load())?.isSuperAdmin ? true : router.parseUrl('/');
};

export const hasPermission =
  (permission: Permission): CanMatchFn =>
  async () => {
    const auth = inject(AuthService);
    const router = inject(Router);
    return (await auth.load())?.permissions.includes(permission) ? true : router.parseUrl('/');
  };

/** A session that expired mid-work sends the user back to the login page. */
export const sessionExpiredInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return next(req).pipe(
    catchError((error: unknown) => {
      const code = error instanceof HttpErrorResponse ? (error.error as { code?: string } | null)?.code : undefined;
      const isAuthCall = req.url.startsWith('/api/admin/auth/') || req.url.startsWith('/api/admin/links/');
      if (code === 'not_authenticated' && !isAuthCall) {
        auth.clear();
        void router.navigateByUrl('/login');
      }
      return throwError(() => error);
    }),
  );
};
