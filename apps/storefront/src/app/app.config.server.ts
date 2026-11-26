import {
  ApplicationConfig,
  DOCUMENT,
  ErrorHandler,
  REQUEST,
  TransferState,
  inject,
  mergeApplicationConfig,
  provideAppInitializer,
} from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { THEME_ATTRIBUTE, readThemeCookie } from '@hg/theme';
import { appConfig } from './app.config';
import { applyCspNonce, provideCspNonce } from './core/csp-nonce';
import { API_ORIGIN, SEO_INDEXING, SEO_INDEXING_STATE, SITE_ORIGIN } from './core/server-tokens';
import { serverRoutes } from './app.routes.server';
import { readServerEnv } from '../server-env';
import { ServerErrorHandler } from '../ssr-error-handler';

/** Renders the saved light/dark choice into <html> so the first paint is already correct (GEN-05). */
function applySavedTheme(): void {
  const theme = readThemeCookie(inject(REQUEST, { optional: true })?.headers.get('cookie'));
  if (theme) inject(DOCUMENT).documentElement.setAttribute(THEME_ATTRIBUTE, theme);
}

/** Hands the indexing switch to the browser, so pages it renders after navigation keep the same robots tag. */
function transferSeoIndexing(): void {
  inject(TransferState).set(SEO_INDEXING_STATE, inject(SEO_INDEXING));
}

const serverConfig: ApplicationConfig = {
  providers: [
    provideServerRendering(withRoutes(serverRoutes)),
    // Render errors as scrubbed JSON, reported to the API (spec 9b.6), never Angular's raw console.error.
    { provide: ErrorHandler, useClass: ServerErrorHandler },
    provideAppInitializer(applySavedTheme),
    provideAppInitializer(transferSeoIndexing),
    provideCspNonce(),
    provideAppInitializer(applyCspNonce),
    // The server render calls the API directly (API_URL), not through the browser-facing address.
    { provide: API_ORIGIN, useFactory: () => readServerEnv().apiUrl },
    { provide: SITE_ORIGIN, useFactory: () => readServerEnv().siteUrl },
    // NFR-06: indexing stays off (every page noindex) unless SEO_INDEXING=true — production only.
    { provide: SEO_INDEXING, useFactory: () => readServerEnv().indexing },
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
