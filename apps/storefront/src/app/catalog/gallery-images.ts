import type { ImageRef, ProductDetail, VariantDetail } from '@hg/models';

/** Photos shown for a variant: its color's photos first, then the product's own, without repeats. */
export function galleryImages(product: ProductDetail, variant: VariantDetail): ImageRef[] {
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const img of [...variant.images, ...product.images]) {
    if (seen.has(img.url)) continue;
    seen.add(img.url);
    out.push(img);
  }
  return out;
}
