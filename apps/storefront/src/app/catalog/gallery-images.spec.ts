import { describe, expect, it } from 'vitest';
import type { ImageRef, ProductDetail, VariantDetail } from '@hg/models';
import { galleryImages } from './gallery-images';

const img = (url: string): ImageRef => ({ url, altHe: url });
const p = (images: ImageRef[]) => ({ images }) as ProductDetail;
const v = (images: ImageRef[]) => ({ images }) as VariantDetail;

describe('galleryImages', () => {
  it('puts color photos first and removes duplicates', () => {
    const result = galleryImages(p([img('a'), img('b'), img('c')]), v([img('c'), img('d')]));
    expect(result.map((i) => i.url)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('falls back to product photos when the color has none', () => {
    expect(galleryImages(p([img('a'), img('b')]), v([])).map((i) => i.url)).toEqual(['a', 'b']);
  });

  it('returns [] when there are none', () => {
    expect(galleryImages(p([]), v([]))).toEqual([]);
  });
});
