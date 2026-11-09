import { buildRobotsTxt, buildSitemapXml } from './seo-routes';

describe('buildSitemapXml', () => {
  const origin = 'https://example.co.il';
  const xml = buildSitemapXml(
    {
      products: [{ slug: 'alba-corner-sofa', updatedAt: '2026-10-05T21:30:00.000Z' }],
      categories: [{ slug: 'sofas' }, { slug: 'a&b' }],
      rooms: [{ slug: 'living-room' }],
    },
    origin,
  );
  const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);

  it('is a urlset with absolute URLs for home, rooms, categories, products and the sizing guide', () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(locs).toEqual([
      `${origin}/`,
      `${origin}/room/living-room`,
      `${origin}/category/sofas`,
      `${origin}/category/a&amp;b`,
      `${origin}/product/alba-corner-sofa`,
      `${origin}/sizing-guide`,
    ]);
    expect(locs.every((l) => l.startsWith(`${origin}/`))).toBe(true);
  });

  it('never lists search or favorites', () => {
    expect(xml).not.toContain('/search');
    expect(xml).not.toContain('/favorites');
  });

  it('gives products a lastmod date (YYYY-MM-DD) from updatedAt', () => {
    expect(xml).toContain(`<url><loc>${origin}/product/alba-corner-sofa</loc><lastmod>2026-10-05</lastmod></url>`);
    expect(xml.match(/<lastmod>/g)).toHaveLength(1);
  });

  it('escapes & in URLs', () => {
    expect(xml).not.toMatch(/&(?!amp;)/);
  });
});

describe('buildRobotsTxt', () => {
  it('with indexing on, allows the site except search and favorites and points to the sitemap', () => {
    expect(buildRobotsTxt(true, 'https://example.co.il')).toBe(
      'User-agent: *\nDisallow: /search\nDisallow: /favorites\n\nSitemap: https://example.co.il/sitemap.xml\n',
    );
  });

  it('with indexing off, disallows everything', () => {
    expect(buildRobotsTxt(false, 'https://example.co.il')).toBe('User-agent: *\nDisallow: /\n');
  });
});
