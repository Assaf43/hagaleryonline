import type { AdminImage, ImageKindCode, ImageRef } from '@hg/models';
import { copyKey, defaultWidth } from './image-processor.js';
import type { StorageProvider } from './storage.js';

/** An image row as stored (placeholders in dev data have no storage key). */
export interface StoredImage {
  id: number;
  url: string;
  storageKey: string | null;
  widths: number[];
  width: number | null;
  height: number | null;
  altHe: string;
  kind: 'CUTOUT' | 'LIFESTYLE';
}

const srcset = (storage: StorageProvider, image: StoredImage, format: 'webp' | 'avif') =>
  image.widths.map((w) => `${storage.publicUrl(copyKey(image.storageKey!, w, format))} ${w}w`).join(', ');

/** What the site gets: one URL, plus srcsets for uploaded photos. */
export function toImageRef(storage: StorageProvider, image: StoredImage): ImageRef {
  if (!image.storageKey || !image.widths.length) return { url: image.url, altHe: image.altHe };
  return {
    url: storage.publicUrl(copyKey(image.storageKey, defaultWidth(image.widths), 'webp')),
    altHe: image.altHe,
    srcset: srcset(storage, image, 'webp'),
    avifSrcset: srcset(storage, image, 'avif'),
    width: image.width ?? undefined,
    height: image.height ?? undefined,
  };
}

/** Smallest size, for thumbnails in the admin. */
export function thumbUrl(storage: StorageProvider, image: Pick<StoredImage, 'url' | 'storageKey' | 'widths'>): string {
  return image.storageKey && image.widths.length
    ? storage.publicUrl(copyKey(image.storageKey, image.widths[0], 'webp'))
    : image.url;
}

export function toAdminImage(
  storage: StorageProvider,
  image: StoredImage & { colorValue: { code: string } | null },
): AdminImage {
  const has = image.storageKey && image.widths.length;
  return {
    id: image.id,
    url: has ? storage.publicUrl(copyKey(image.storageKey!, defaultWidth(image.widths), 'webp')) : image.url,
    thumbUrl: thumbUrl(storage, image),
    colorCode: image.colorValue?.code ?? null,
    altHe: image.altHe,
    kind: image.kind.toLowerCase() as ImageKindCode,
    width: image.width,
    height: image.height,
  };
}

/** Private key of the untouched upload. */
export const originalKey = (storageKey: string, ext: string) => `originals/${storageKey}.${ext}`;

/** Every file of a stored photo, for deletion (the original under whichever extension it has). */
export function imageFiles(image: Pick<StoredImage, 'storageKey' | 'widths'>) {
  const key = image.storageKey;
  if (!key) return [];
  return [
    ...image.widths.flatMap((w) =>
      (['webp', 'avif'] as const).map((f) => ({ key: copyKey(key, w, f), visibility: 'public' as const })),
    ),
    ...['jpg', 'png', 'webp'].map((ext) => ({ key: originalKey(key, ext), visibility: 'private' as const })),
  ];
}
