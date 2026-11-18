import type { BannerView, ImageRef } from '@hg/models';
import type { Banner, ContentImage } from '../generated/prisma/client.js';
import { toImageRef } from '../media/image-urls.js';
import type { StorageProvider } from '../media/storage.js';

export type BannerWithImages = Banner & { image: ContentImage; mobileImage: ContentImage | null };

/** Prisma include that gives a banner both of its photos. */
export const bannerImages = { image: true, mobileImage: true } as const;

/** A content photo as the site reads it (one URL plus WebP / AVIF srcsets), with the alt text of the row using it. */
export function contentImageRef(storage: StorageProvider, image: ContentImage, altHe: string): ImageRef {
  return toImageRef(storage, {
    id: image.id,
    url: '',
    storageKey: image.storageKey,
    widths: image.widths,
    width: image.width,
    height: image.height,
    altHe,
    kind: 'LIFESTYLE',
  });
}

/** A banner for the site (home sections, Task 7). Whether it is live now is the caller's check (`isLive`). */
export function bannerView(storage: StorageProvider, row: BannerWithImages): BannerView {
  return {
    id: row.id,
    headlineHe: row.headlineHe,
    sublineHe: row.sublineHe,
    ctaLabelHe: row.ctaLabelHe,
    linkUrl: row.linkUrl,
    image: contentImageRef(storage, row.image, row.altHe),
    mobileImage: row.mobileImage ? contentImageRef(storage, row.mobileImage, row.altHe) : null,
    altHe: row.altHe,
  };
}
