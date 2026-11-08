/**
 * Light / dark theme (GEN-05).
 *
 * The saved choice lives in a cookie so the SSR render can set `data-theme` on <html>
 * before first paint. Without a saved choice there is no attribute and the site is light
 * (decision 63: light by default, dark only when chosen; see @hg/styles/tokens).
 */

export type Theme = 'light' | 'dark';

export const THEME_COOKIE = 'hg-theme';
export const THEME_ATTRIBUTE = 'data-theme';

const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

function isTheme(value: string | undefined | null): value is Theme {
  return value === 'light' || value === 'dark';
}

/** Reads the saved theme from a Cookie header or `document.cookie`. */
export function readThemeCookie(cookieHeader: string | null | undefined): Theme | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === THEME_COOKIE && isTheme(value)) return value;
  }
  return null;
}

/** The theme currently shown: the saved choice, otherwise light. */
export function effectiveTheme(saved: Theme | null): Theme {
  return saved ?? 'light';
}

/** Applies and remembers the user's choice. Browser only. */
export function saveTheme(doc: Document, theme: Theme): void {
  doc.documentElement.setAttribute(THEME_ATTRIBUTE, theme);
  doc.cookie = `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
