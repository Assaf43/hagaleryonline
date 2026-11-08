import { InjectionToken, inject } from '@angular/core';
import type { HttpInterceptorFn } from '@angular/common/http';

/**
 * Where the server render reaches the API (e.g. http://localhost:3000). Provided only on the
 * server; in the browser `/api` is relative to the page (proxied in dev, same host in production).
 */
export const API_ORIGIN = new InjectionToken<string>('API_ORIGIN');

/** The public address of the site, for canonical links and Open Graph (SEO). */
export const SITE_ORIGIN = new InjectionToken<string>('SITE_ORIGIN', {
  factory: () => 'https://hagaleryonline.co.il',
});

/** On the server, sends `/api` and `/media` requests straight to the API process. */
export const apiOriginInterceptor: HttpInterceptorFn = (req, next) => {
  const origin = inject(API_ORIGIN, { optional: true });
  if (!origin || !/^\/(api|media)\//.test(req.url)) return next(req);
  return next(req.clone({ url: `${origin}${req.url}` }));
};
