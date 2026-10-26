import {
  ApplicationConfig,
  DOCUMENT,
  REQUEST,
  inject,
  mergeApplicationConfig,
  provideAppInitializer,
} from '@angular/core';
import { provideServerRendering, withRoutes } from '@angular/ssr';
import { THEME_ATTRIBUTE, readThemeCookie } from '@hg/theme';
import { appConfig } from './app.config';
import { serverRoutes } from './app.routes.server';

/** Renders the saved light/dark choice into <html> so the first paint is already correct (GEN-05). */
function applySavedTheme(): void {
  const theme = readThemeCookie(inject(REQUEST, { optional: true })?.headers.get('cookie'));
  if (theme) inject(DOCUMENT).documentElement.setAttribute(THEME_ATTRIBUTE, theme);
}

const serverConfig: ApplicationConfig = {
  providers: [provideServerRendering(withRoutes(serverRoutes)), provideAppInitializer(applySavedTheme)],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);
