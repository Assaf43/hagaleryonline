import type { SitemapData } from '@hg/models';
import type { Express } from 'express';

/** How long a built sitemap.xml is reused before the catalog is asked again. */
const SITEMAP_TTL_MS = 60 * 60 * 1000;

const escapeXml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');

/**
 * sitemap.xml (NFR-06): home, rooms, categories, products and the sizing guide, as absolute URLs.
 * Search, favorites, filtered and variant URLs are never listed.
 */
export function buildSitemapXml(data: SitemapData, origin: string): string {
  const url = (path: string, lastmod?: string) =>
    `<url><loc>${escapeXml(origin + path)}</loc>${lastmod ? `<lastmod>${lastmod}</lastmod>` : ''}</url>`;
  const urls = [
    url('/'),
    ...data.rooms.map((r) => url(`/room/${r.slug}`)),
    ...data.categories.map((c) => url(`/category/${c.slug}`)),
    ...data.products.map((p) => url(`/product/${p.slug}`, p.updatedAt.slice(0, 10))),
    url('/sizing-guide'),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...urls,
    '</urlset>',
    '',
  ].join('\n');
}

/** robots.txt (NFR-06): everything is closed until SEO_INDEXING is switched on in production. */
export function buildRobotsTxt(indexing: boolean, origin: string): string {
  if (!indexing) return 'User-agent: *\nDisallow: /\n';
  return `User-agent: *\nDisallow: /search\nDisallow: /favorites\n\nSitemap: ${origin}/sitemap.xml\n`;
}

/** `GET /sitemap.xml` and `GET /robots.txt`; register before the static and Angular handlers. */
export function registerSeoRoutes(app: Express, env: { apiUrl: string; siteUrl: string; indexing: boolean }): void {
  let cached: { xml: string; expires: number } | null = null;

  app.get('/sitemap.xml', async (_req, res) => {
    if (!cached || cached.expires <= Date.now()) {
      try {
        const response = await fetch(`${env.apiUrl}/api/seo/sitemap`, { signal: AbortSignal.timeout(10_000) });
        if (!response.ok) throw new Error(`sitemap API answered ${response.status}`);
        const data = (await response.json()) as SitemapData;
        cached = { xml: buildSitemapXml(data, env.siteUrl), expires: Date.now() + SITEMAP_TTL_MS };
      } catch (error) {
        // Never an empty sitemap: search engines retry a 503 later. The failure is not cached.
        console.error('sitemap.xml: catalog API unavailable', error);
        res.status(503).type('text/plain').send('Sitemap temporarily unavailable');
        return;
      }
    }
    res.type('application/xml').send(cached.xml);
  });

  app.get('/robots.txt', (_req, res) => {
    res.type('text/plain').send(buildRobotsTxt(env.indexing, env.siteUrl));
  });
}
