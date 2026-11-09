import type { Express } from 'express';
import { buildRobotsTxt, buildSitemapXml, registerSeoRoutes } from './seo-routes';

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

describe('registerSeoRoutes /sitemap.xml', () => {
  type Handler = (req: unknown, res: FakeRes) => unknown;
  interface FakeRes {
    statusCode: number;
    contentType: string;
    body: string;
    status(code: number): FakeRes;
    type(t: string): FakeRes;
    send(b: string): FakeRes;
  }
  const newRes = (): FakeRes => {
    const res: FakeRes = {
      statusCode: 200,
      contentType: '',
      body: '',
      status(code) {
        res.statusCode = code;
        return res;
      },
      type(t) {
        res.contentType = t;
        return res;
      },
      send(b) {
        res.body = b;
        return res;
      },
    };
    return res;
  };
  const data = { products: [], categories: [], rooms: [] };
  const okResponse = () => ({ ok: true, status: 200, json: async () => data });

  let handlers: Record<string, Handler>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const request = async (path: string): Promise<FakeRes> => {
    const res = newRes();
    await handlers[path]({}, res);
    return res;
  };

  beforeEach(() => {
    handlers = {};
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const app = { get: (path: string, h: Handler) => void (handlers[path] = h) } as unknown as Express;
    registerSeoRoutes(app, { apiUrl: 'http://api', siteUrl: 'https://example.co.il', indexing: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('answers 503 text/plain when the fetch rejects', async () => {
    fetchMock.mockRejectedValue(new Error('down'));
    const res = await request('/sitemap.xml');
    expect(res.statusCode).toBe(503);
    expect(res.contentType).toBe('text/plain');
  });

  it('answers 503 text/plain when the API answers non-OK', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => data });
    const res = await request('/sitemap.xml');
    expect(res.statusCode).toBe(503);
    expect(res.contentType).toBe('text/plain');
  });

  it('reuses the sitemap within the TTL without calling fetch again', async () => {
    fetchMock.mockResolvedValue(okResponse());
    const first = await request('/sitemap.xml');
    const second = await request('/sitemap.xml');
    expect(first.statusCode).toBe(200);
    expect(first.contentType).toBe('application/xml');
    expect(second.body).toBe(first.body);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure: the next request calls fetch again', async () => {
    fetchMock.mockRejectedValueOnce(new Error('down')).mockResolvedValueOnce(okResponse());
    expect((await request('/sitemap.xml')).statusCode).toBe(503);
    expect((await request('/sitemap.xml')).statusCode).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
