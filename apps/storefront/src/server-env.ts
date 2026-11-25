/** enforce = Content-Security-Policy, report-only = Content-Security-Policy-Report-Only (staging may start there). */
export type CspMode = 'enforce' | 'report-only' | 'off';

const CSP_MODES: readonly string[] = ['enforce', 'report-only', 'off'] satisfies CspMode[];

export interface ServerEnv {
  apiUrl: string;
  siteUrl: string;
  indexing: boolean;
  csp: CspMode;
}

/**
 * API_URL / SITE_URL (defaults, no trailing slash), SEO_INDEXING (only the exact string 'true' turns it on) and
 * STOREFRONT_CSP (default `enforce` with NODE_ENV=production, else `off` — the Vite dev server injects scripts the
 * policy would block; an empty or unknown value takes the default).
 */
export function readServerEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const csp = env['STOREFRONT_CSP'] ?? '';
  return {
    apiUrl: (env['API_URL'] || 'http://localhost:3000').replace(/\/$/, ''),
    siteUrl: (env['SITE_URL'] || 'https://hagaleryonline.co.il').replace(/\/$/, ''),
    indexing: env['SEO_INDEXING'] === 'true',
    csp: CSP_MODES.includes(csp) ? (csp as CspMode) : env['NODE_ENV'] === 'production' ? 'enforce' : 'off',
  };
}
