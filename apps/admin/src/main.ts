import { bootstrapApplication } from '@angular/platform-browser';
import { THEME_ATTRIBUTE, readThemeCookie } from '@hg/theme';
import { appConfig } from './app/app.config';
import { App } from './app/app';

// Apply the saved light/dark choice before the first render (GEN-05). No choice = device setting.
const savedTheme = readThemeCookie(document.cookie);
if (savedTheme) document.documentElement.setAttribute(THEME_ATTRIBUTE, savedTheme);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
