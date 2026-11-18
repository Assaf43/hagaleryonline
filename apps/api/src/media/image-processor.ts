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
 * Reads an upload's header by its content (never its name): the format, and the size as shown (after EXIF rotation).
 * `minLongSide` is the catalog's minimum unless the caller sets its own.
 */
async function inspect(
  input: Buffer,
  { minLongSide = IMAGE_UPLOAD.minLongSide }: { minLongSide?: number } = {},
): Promise<{ originalExt: string; width: number; height: number }> {
  if (input.length > IMAGE_UPLOAD.maxBytes) throw new ImageRejected('too_large');
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 80_000_000 }).metadata();
  } catch {
    throw new ImageRejected('unreadable');
  }
  const originalExt = meta.format && FORMATS[meta.format];
  if (!originalExt) throw new ImageRejected('type');

  const { width, height } = meta.autoOrient;
  if (Math.max(width, height) < minLongSide) throw new ImageRejected('too_small');
  return { originalExt, width, height };
}

/** Upright, sRGB, at most `width` wide (never upscaled), without metadata. */
const upright = (input: Buffer, width: number) =>
  sharp(input, { limitInputPixels: 80_000_000 })
    .autoOrient()
    .resize({ width, withoutEnlargement: true })
    .toColorspace('srgb');

export interface ProcessImageOptions {
  /** Widths to make (ascending); default `IMAGE_WIDTHS` (catalog). Content photos add 2400 (`CONTENT_IMAGE`). */
  widths?: readonly number[];
  /** Minimum long side in px; default the catalog's `IMAGE_UPLOAD.minLongSide`. */
  minLongSide?: number;
}

/**
 * Checks an upload by its content, turns it upright (phone photos store rotation in EXIF), converts
 * it to sRGB and makes the resized copies. sharp drops all metadata unless asked to keep it.
 * Without options it is the catalog's pipeline (480 / 960 / 1600, at least 600 px).
 */
export async function processImage(
  input: Buffer,
  { widths: wanted = IMAGE_WIDTHS, minLongSide }: ProcessImageOptions = {},
): Promise<ProcessedImage> {
  const { originalExt, width, height } = await inspect(input, minLongSide === undefined ? {} : { minLongSide });
  const widths = [...new Set(wanted.map((w) => Math.min(w, width)))];
  try {
    const copies = await Promise.all(
      widths.map(async (w) => {
        const resized = upright(input, w);
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

/**
 * The same content checks as `processImage` (a JPEG, PNG or WebP that sharp can read, upright, metadata removed), but
 * one WebP of at most `maxWidth` and no kept original: private photos that only staff look at (damaged-product photos,
 * spec §7.1). No minimum size: a small customer photo is still evidence. The upload size limit is the caller's (the
 * support form allows 10 MB).
 */
export async function processPrivatePhoto(input: Buffer, maxWidth = 1600): Promise<Buffer> {
  await inspect(input, { minLongSide: 1 });
  try {
    return await upright(input, maxWidth).webp({ quality: 82 }).toBuffer();
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
