import { InjectionToken, TransferState, inject, makeStateKey } from '@angular/core';
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

/**
 * Whether search engines may index the site (NFR-06): `SEO_INDEXING=true` only in production.
 * The server reads the environment and hands the value to the browser in TransferState
 * (`SEO_INDEXING_STATE`); when it is false every page is `noindex`.
 */
export const SEO_INDEXING = new InjectionToken<boolean>('SEO_INDEXING', { factory: () => false });
export const SEO_INDEXING_STATE = makeStateKey<boolean>('seo-indexing');

/** Browser side: the value the server render wrote into TransferState (off when missing). */
export const provideSeoIndexingFromState = () => ({
  provide: SEO_INDEXING,
  useFactory: () => inject(TransferState).get(SEO_INDEXING_STATE, false),
});

/** On the server, sends `/api` and `/media` requests straight to the API process. */
export const apiOriginInterceptor: HttpInterceptorFn = (req, next) => {
  const origin = inject(API_ORIGIN, { optional: true });
  if (!origin || !/^\/(api|media)\//.test(req.url)) return next(req);
  return next(req.clone({ url: `${origin}${req.url}` }));
};
