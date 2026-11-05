import sharp, { type Metadata } from 'sharp';
import { IMAGE_UPLOAD, type ImageUploadProblem } from '@hg/models';

/** Widths made for every photo (srcset). Never upscaled: a smaller photo gets its own width instead. */
export const IMAGE_WIDTHS = [480, 960, 1600] as const;
/** The size used where one URL is needed (lists, previews). */
export const DEFAULT_WIDTH = 960;

const FORMATS: Record<string, string> = { jpeg: 'jpg', png: 'png', webp: 'webp' };

export interface ProcessedImage {
  /** Extension of the original, from its content (not its name). */
  originalExt: string;
  width: number;
  height: number;
  /** One WebP and one AVIF per width, without any metadata (no camera details, no GPS). */
  copies: { width: number; webp: Buffer; avif: Buffer }[];
}

export class ImageRejected extends Error {
  constructor(readonly problem: ImageUploadProblem) {
    super(problem);
  }
}

/**
 * Checks an upload by its content, turns it upright (phone photos store rotation in EXIF), converts
 * it to sRGB and makes the resized copies. sharp drops all metadata unless asked to keep it.
 */
export async function processImage(input: Buffer): Promise<ProcessedImage> {
  if (input.length > IMAGE_UPLOAD.maxBytes) throw new ImageRejected('too_large');
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 80_000_000 }).metadata();
  } catch {
    throw new ImageRejected('unreadable');
  }
  const originalExt = meta.format && FORMATS[meta.format];
  if (!originalExt) throw new ImageRejected('type');

  // Size as shown, after EXIF rotation.
  const { width, height } = meta.autoOrient;
  if (Math.max(width, height) < IMAGE_UPLOAD.minLongSide) throw new ImageRejected('too_small');

  const widths = [...new Set(IMAGE_WIDTHS.map((w) => Math.min(w, width)))];
  try {
    const copies = await Promise.all(
      widths.map(async (w) => {
        const resized = sharp(input, { limitInputPixels: 80_000_000 })
          .autoOrient()
          .resize({ width: w, withoutEnlargement: true })
          .toColorspace('srgb');
        const [webp, avif] = await Promise.all([
          resized.clone().webp({ quality: 82 }).toBuffer(),
          resized.clone().avif({ quality: 55, effort: 4 }).toBuffer(),
        ]);
        return { width: w, webp, avif };
      }),
    );
    return { originalExt, width, height, copies };
  } catch {
    throw new ImageRejected('unreadable');
  }
}

/** Public keys of one stored photo. */
export const copyKey = (storageKey: string, width: number, format: 'webp' | 'avif') =>
  `${storageKey}-${width}.${format}`;

/** The width to use as the default URL: the configured one, or the largest there is. */
export const defaultWidth = (widths: readonly number[]) =>
  widths.includes(DEFAULT_WIDTH) ? DEFAULT_WIDTH : widths[widths.length - 1];
