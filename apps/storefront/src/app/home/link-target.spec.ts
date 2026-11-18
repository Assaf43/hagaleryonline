import { linkTarget } from './link-target';

describe('linkTarget', () => {
  it('treats https, mailto and tel as external', () => {
    for (const url of ['https://example.com/x?a=1', 'mailto:a@b.co', 'tel:+972500000000']) {
      const t = linkTarget(url);
      expect(t.external).toBe(true);
      expect(t.href).toBe(url);
    }
  });

  it('splits a plain site path', () => {
    expect(linkTarget('/category/sofas')).toMatchObject({
      external: false,
      path: '/category/sofas',
      queryParams: {},
      fragment: undefined,
    });
  });

  it('keeps the query (repeated keys too) and the fragment', () => {
    const t = linkTarget('/search?q=sofa&attr.color=red&attr.color=blue#top');
    expect(t.path).toBe('/search');
    expect(t.queryParams).toEqual({ q: 'sofa', 'attr.color': ['red', 'blue'] });
    expect(t.fragment).toBe('top');
  });
});
