import {
  ApplicationConfig,
  DOCUMENT,
  REQUEST,
  TransferState,
  inject,
  mergeApplicationConfig,
  provideAppInitializer,
} from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { THEME_ATTRIBUTE, readThemeCookie } from '@hg/theme';
import { appConfig } from './app.config';
import { API_ORIGIN, SEO_INDEXING, SEO_INDEXING_STATE, SITE_ORIGIN } from './core/server-tokens';
import { serverRoutes } from './app.routes.server';

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
    provideAppInitializer(applySavedTheme),
    provideAppInitializer(transferSeoIndexing),
    // The server render calls the API directly (API_URL), not through the browser-facing address.
    { provide: API_ORIGIN, useFactory: () => (process.env['API_URL'] || 'http://localhost:3000').replace(/\/$/, '') },
    {
      provide: SITE_ORIGIN,
      useFactory: () => (process.env['SITE_URL'] || 'https://hagaleryonline.co.il').replace(/\/$/, ''),
    },
    // NFR-06: indexing stays off (every page noindex) unless SEO_INDEXING=true — production only.
    { provide: SEO_INDEXING, useFactory: () => process.env['SEO_INDEXING'] === 'true' },
  ],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
