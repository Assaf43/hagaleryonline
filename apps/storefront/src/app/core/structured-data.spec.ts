import type { FulfillmentMode, ProductDetail, VariantDetail } from '@hg/models';
import { breadcrumbJsonLd, crumbItems, homeJsonLd, productJsonLd, serializeJsonLd } from './structured-data';

const variant = (price: number, fulfillment: FulfillmentMode = 'in_stock'): VariantDetail =>
  ({ sku: `S${price}${fulfillment}`, price, compareAtPrice: null, inStock: true, fulfillment }) as VariantDetail;

const product = (variants: VariantDetail[], extra: Partial<ProductDetail> = {}): ProductDetail =>
  ({
    id: 1,
    slug: 'alba',
    modelName: 'ALBA',
    nameHe: 'ספה',
    descriptionHe: '<p>טקסט</p>',
    breadcrumbs: [],
    images: [
      {
        url: '/media/a-960.webp',
        altHe: '',
        srcset: '/media/a-480.webp 480w, /media/a-1600.webp 1600w, /media/a-960.webp 960w',
      },
    ],
    variants,
    ...extra,
  }) as ProductDetail;

const O = 'https://example.test';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const make = (p: ProductDetail) => productJsonLd(p, `${O}/product/alba`, O) as Record<string, any>;

describe('structured data', () => {
  it('single price gives an Offer in shekels', () => {
    const d = make(product([variant(129900), variant(129900)]));
    expect(d['@type']).toBe('Product');
    expect(d['name']).toBe('ALBA ספה');
    expect(d['brand']).toEqual({ '@type': 'Brand', name: 'NESTO' });
    expect(d['offers']).toMatchObject({
      '@type': 'Offer',
      price: '1299.00',
      priceCurrency: 'ILS',
      url: `${O}/product/alba`,
    });
  });

  it('different prices give an AggregateOffer with low, high and count', () => {
    const d = make(product([variant(100000), variant(250050), variant(150000)]));
    expect(d['offers']).toMatchObject({
      '@type': 'AggregateOffer',
      lowPrice: '1000.00',
      highPrice: '2500.50',
      offerCount: 3,
      priceCurrency: 'ILS',
    });
  });

  it.each([
    ['in_stock', 'InStock'],
    ['pre_order', 'PreOrder'],
    ['made_to_order', 'MadeToOrder'],
    ['out_of_stock', 'OutOfStock'],
  ] as const)('maps %s availability', (mode, name) => {
    expect(make(product([variant(100, mode)]))['offers'].availability).toBe(`https://schema.org/${name}`);
  });

  it('uses the best availability among variants', () => {
    const d = make(product([variant(100, 'out_of_stock'), variant(100, 'made_to_order'), variant(100, 'pre_order')]));
    expect(d['offers'].availability).toBe('https://schema.org/PreOrder');
  });

  it('strips and caps the description, decodes entities', () => {
    const text = make(product([variant(1)], { descriptionHe: '<p>a &amp; b</p><ul><li>c</li></ul>' }));
    expect(text['description']).toBe('a & b c');
    const long = make(product([variant(1)], { descriptionHe: `<p>${'x'.repeat(900)}</p>` }));
    expect(long['description'].length).toBe(500);
  });

  it('gives absolute image URLs, largest size, at most 5', () => {
    const imgs = Array.from({ length: 7 }, (_, i) => ({ url: `/media/${i}.webp`, altHe: '' }));
    const d = make(product([variant(1)], { images: imgs }));
    expect(d['image']).toHaveLength(5);
    expect(d['image'][0]).toBe(`${O}/media/0.webp`);
    expect(make(product([variant(1)]))['image'][0]).toBe(`${O}/media/a-1600.webp`);
  });

  it('serializeJsonLd escapes </script>', () => {
    const out = serializeJsonLd(make(product([variant(1)], { descriptionHe: 'a</script><script>x' })));
    expect(out).not.toContain('</script');
    expect(serializeJsonLd({ a: '<b>' })).toBe('{"a":"\\u003cb>"}');
    expect(JSON.parse(serializeJsonLd({ a: '<b>' }))).toEqual({ a: '<b>' });
    const entity = serializeJsonLd(make(product([variant(1)], { descriptionHe: '&lt;/script&gt;' })));
    expect(entity).not.toContain('</script');
  });

  it('breadcrumbs keep absolute URLs in order', () => {
    const d = breadcrumbJsonLd([
      { name: 'בית', url: `${O}/` },
      { name: 'ספות', url: `${O}/category/sofas` },
    ]);
    expect(d).toMatchObject({
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'בית', item: `${O}/` },
        { '@type': 'ListItem', position: 2, name: 'ספות', item: `${O}/category/sofas` },
      ],
    });
  });

  it('home data has WebSite and Organization', () => {
    const d = homeJsonLd(O);
    expect(d.map((x: object) => (x as { '@type': string })['@type'])).toEqual(['WebSite', 'Organization']);
    expect(d[0]).toMatchObject({ name: 'NESTO', url: O });
    expect(d[1]).toMatchObject({ name: 'NESTO', url: O });
  });

  it('category and room crumbs get single-slash absolute URLs', () => {
    const home = { label: 'דף הבית', link: ['/'] };
    expect(
      crumbItems(
        [home, { label: 'ספות', link: ['/category', 'sofas'] }, { label: 'פינתיות', link: null }],
        '/category/corner',
        O,
      ),
    ).toEqual([
      { name: 'דף הבית', url: `${O}/` },
      { name: 'ספות', url: `${O}/category/sofas` },
      { name: 'פינתיות', url: `${O}/category/corner` },
    ]);
    expect(crumbItems([home, { label: 'סלון', link: null }], '/room/living', O)[1].url).toBe(`${O}/room/living`);
  });

  it('omits offers when there are no variants', () => {
    const d = make(product([]));
    expect(d['offers']).toBeUndefined();
    expect(JSON.stringify(d)).not.toContain('Infinity');
  });
});
