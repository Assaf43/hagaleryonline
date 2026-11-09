import { BRAND, type FulfillmentMode, type ProductDetail } from '@hg/models';

const AVAILABILITY: Record<FulfillmentMode, string> = {
  in_stock: 'InStock',
  pre_order: 'PreOrder',
  made_to_order: 'MadeToOrder',
  out_of_stock: 'OutOfStock',
};
const AVAILABILITY_ORDER: FulfillmentMode[] = ['in_stock', 'pre_order', 'made_to_order', 'out_of_stock'];

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text: string): string {
  return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (all, dec?: string, hex?: string, name?: string) => {
    if (name) return ENTITIES[name.toLowerCase()] ?? all;
    const code = dec ? Number(dec) : parseInt(hex ?? '', 16);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : all;
  });
}

function plainText(html: string, max: number): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** The largest copy named in a `srcset`, else the default URL. */
function largestUrl(image: { url: string; srcset?: string }): string {
  let best = image.url;
  let bestWidth = 0;
  for (const part of (image.srcset ?? '').split(',')) {
    const [url, size] = part.trim().split(/\s+/);
    const width = parseInt(size ?? '', 10);
    if (url && width > bestWidth) {
      best = url;
      bestWidth = width;
    }
  }
  return best;
}

const shekels = (agorot: number): string => (agorot / 100).toFixed(2);

/** Schema.org Product with Offer / AggregateOffer (NFR-05). Prices are shekels, including VAT. */
export function productJsonLd(p: ProductDetail, url: string, origin: string): object {
  const prices = p.variants.map((v) => v.price);
  const description = plainText(p.descriptionHe, 500);
  const base = {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: `${p.modelName} ${p.nameHe}`,
    url,
    ...(description ? { description } : {}),
    image: p.images.slice(0, 5).map((i) => new URL(largestUrl(i), origin).href),
    brand: { '@type': 'Brand', name: BRAND.name },
  };
  if (!prices.length) return base;
  const low = Math.min(...prices);
  const high = Math.max(...prices);
  const best = p.variants.reduce<FulfillmentMode>(
    (acc, v) => (AVAILABILITY_ORDER.indexOf(v.fulfillment) < AVAILABILITY_ORDER.indexOf(acc) ? v.fulfillment : acc),
    'out_of_stock',
  );
  const availability = `https://schema.org/${AVAILABILITY[best]}`;
  const offers =
    low === high
      ? { '@type': 'Offer', url, price: shekels(low), priceCurrency: 'ILS', availability }
      : {
          '@type': 'AggregateOffer',
          url,
          lowPrice: shekels(low),
          highPrice: shekels(high),
          offerCount: p.variants.length,
          priceCurrency: 'ILS',
          availability,
        };
  return { ...base, offers };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): object {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({ '@type': 'ListItem', position: i + 1, name: it.name, item: it.url })),
  };
}

/** Router link segments (`['/category', 'sofas']`) as one root-relative path with single slashes. */
export function linkPath(link: string[]): string {
  return (
    '/' +
    link
      .map((seg) => seg.replace(/^\/+|\/+$/g, ''))
      .filter(Boolean)
      .join('/')
  );
}

/** Visible crumbs as absolute breadcrumb items; the crumb without a link is the current page. */
export function crumbItems(
  crumbs: { label: string; link: string[] | null }[],
  currentPath: string,
  origin: string,
): { name: string; url: string }[] {
  return crumbs.map((c) => ({ name: c.label, url: `${origin}${c.link ? linkPath(c.link) : currentPath}` }));
}

export function homeJsonLd(origin: string): object[] {
  return [
    { '@context': 'https://schema.org', '@type': 'WebSite', name: BRAND.name, url: origin },
    { '@context': 'https://schema.org', '@type': 'Organization', name: BRAND.name, url: origin },
  ];
}

/** JSON for a `<script type="application/ld+json">`; every `<` is escaped so no text can close the tag. */
export function serializeJsonLd(data: object | object[]): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
