export interface ServerEnv {
  apiUrl: string;
  siteUrl: string;
  indexing: boolean;
}

/** API_URL / SITE_URL (defaults, no trailing slash) and SEO_INDEXING (only the exact string 'true' turns it on). */
export function readServerEnv(env: Record<string, string | undefined> = process.env): ServerEnv {
  return {
    apiUrl: (env['API_URL'] || 'http://localhost:3000').replace(/\/$/, ''),
    siteUrl: (env['SITE_URL'] || 'https://hagaleryonline.co.il').replace(/\/$/, ''),
    indexing: env['SEO_INDEXING'] === 'true',
  };
}
