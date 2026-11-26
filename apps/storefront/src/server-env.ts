import { logJson } from './server-log';

/** enforce = Content-Security-Policy, report-only = Content-Security-Policy-Report-Only (staging may start there). */
export type CspMode = 'enforce' | 'report-only' | 'off';

const CSP_MODES: readonly string[] = ['enforce', 'report-only', 'off'] satisfies CspMode[];

export interface ServerEnv {
  apiUrl: string;
  siteUrl: string;
  indexing: boolean;
  csp: CspMode;
  /** Token for the API's internal error endpoint; empty = render errors are only logged. */
  internalToken: string;
}

/**
 * Logs one warn line for an unknown non-empty STOREFRONT_CSP (never the value). Called once at startup from server.ts:
 * `readServerEnv` itself stays silent because every render injector calls it.
 */
export function warnUnknownCsp(env: Record<string, string | undefined> = process.env): void {
  const csp = env['STOREFRONT_CSP'] ?? '';
  if (csp !== '' && !CSP_MODES.includes(csp)) {
    logJson('warn', 'STOREFRONT_CSP has an unknown value (use enforce, report-only or off); using the default');
  }
}

/**
 * API_URL / SITE_URL (defaults, no trailing slash), SEO_INDEXING (only the exact string 'true' turns it on),
 * INTERNAL_API_TOKEN (optional) and STOREFRONT_CSP (default `enforce` with NODE_ENV=production, else `off` — the Vite dev server injects scripts the
 * policy would block; an empty or unknown value takes the default).
 */
export function readServerEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  const csp = env['STOREFRONT_CSP'] ?? '';
  return {
    apiUrl: (env['API_URL'] || 'http://localhost:3000').replace(/\/$/, ''),
    siteUrl: (env['SITE_URL'] || 'https://hagaleryonline.co.il').replace(/\/$/, ''),
    indexing: env['SEO_INDEXING'] === 'true',
    internalToken: (env['INTERNAL_API_TOKEN'] ?? '').trim(),
    csp: CSP_MODES.includes(csp) ? (csp as CspMode) : env['NODE_ENV'] === 'production' ? 'enforce' : 'off',
  };
}
