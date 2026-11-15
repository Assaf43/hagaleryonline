import { randomBytes } from 'node:crypto';
import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { FilesInterceptor } from '@nestjs/platform-express';
import { transformException } from '@nestjs/platform-express/multer/multer/multer.utils.js';
import type { Request, Response } from 'express';
import type { Observable } from 'rxjs';
import { SUPPORT_LIMITS } from '@hg/models';
import { ImageRejected, processPrivatePhoto } from '../media/image-processor.js';
import { StorageProvider } from '../media/storage.js';
import { supportField } from './support-input.js';

/** Width of the one stored copy of a damaged-product photo. */
export const SUPPORT_PHOTO_WIDTH = 1600;

/** A multipart file as multer hands it over (memory storage). */
export interface UploadedPhoto {
  buffer: Buffer;
}

/** One stored photo, as its `TicketAttachment` row records it. */
export interface StoredPhoto {
  storageKey: string;
  mimeType: string;
  size: number;
}

const Multer = FilesInterceptor('photos', SUPPORT_LIMITS.photosMax, {
  limits: { fileSize: SUPPORT_LIMITS.photoMaxBytes, files: SUPPORT_LIMITS.photosMax, fields: 20, fieldSize: 16_384 },
});

/** The multer errors that are about the photos (multer names its errors by `code`). */
const PHOTO_ERRORS = new Set(['LIMIT_FILE_SIZE', 'LIMIT_FILE_COUNT', 'LIMIT_UNEXPECTED_FILE']);

type ArrayUpload = (req: Request, res: Response, done: (error?: unknown) => void) => void;

/** The multer instance of Nest's `FilesInterceptor` (memory storage, Nest's default field-name limits) for `photos`. */
function photosUpload(): ArrayUpload {
  const inner = new Multer() as unknown as { multer?: { array?: (field: string, max: number) => ArrayUpload } };
  // Fails at startup, not on a customer's upload, if a Nest upgrade renames the field.
  if (typeof inner.multer?.array !== 'function') throw new Error('FilesInterceptor no longer exposes its multer');
  return inner.multer.array('photos', SUPPORT_LIMITS.photosMax);
}

/**
 * Reads the multipart body of `POST /api/support/damaged` into memory: files `photos` (at most 5, 10 MB each). A
 * file too large, a sixth file or a file under another name is the form's 400 `{ field: 'photos' }`; any other
 * multipart problem keeps Nest's own answer (a generic 400). Runs after the guards, so the per-IP throttle has
 * counted the request before any upload is read.
 */
@Injectable()
export class SupportPhotosInterceptor implements NestInterceptor {
  private readonly upload = photosUpload();

  async intercept(ctx: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const http = ctx.switchToHttp();
    await new Promise<void>((resolve, reject) =>
      this.upload(http.getRequest<Request>(), http.getResponse<Response>(), (error) => {
        if (!error) return resolve();
        const code = (error as { code?: unknown }).code;
        reject(
          typeof code === 'string' && PHOTO_ERRORS.has(code)
            ? supportField('photos')
            : transformException(error as Error & { code?: string }),
        );
      }),
    );
    return next.handle();
  }
}

/**
 * Checks 1–5 photos by their content and makes one WebP each (upright, metadata such as GPS removed, at most 1600 px
 * wide). One after another, so five large photos do not all decode at once. Any rejected photo → 400 `photos`.
 */
export async function preparePhotos(files: UploadedPhoto[] | undefined): Promise<Buffer[]> {
  const list = files ?? [];
  if (list.length < SUPPORT_LIMITS.photosMin || list.length > SUPPORT_LIMITS.photosMax) throw supportField('photos');
  const out: Buffer[] = [];
  for (const file of list) {
    try {
      out.push(await processPrivatePhoto(file.buffer, SUPPORT_PHOTO_WIDTH));
    } catch (error) {
      if (error instanceof ImageRejected) throw supportField('photos');
      throw error;
    }
  }
  return out;
}

/** Writes the photos to private storage under `support/<ticketId>/` (never served at /media). */
@Injectable()
export class SupportAttachments {
  constructor(private readonly storage: StorageProvider) {}

  async store(ticketId: string, photos: Buffer[]): Promise<StoredPhoto[]> {
    const stored: StoredPhoto[] = [];
    try {
      for (const photo of photos) {
        const storageKey = `support/${ticketId}/${randomBytes(9).toString('base64url')}.webp`;
        await this.storage.put(storageKey, photo, 'private');
        stored.push({ storageKey, mimeType: 'image/webp', size: photo.length });
      }
    } catch (error) {
      await this.remove(stored);
      throw error;
    }
    return stored;
  }

  /** Deletes stored photos (the ticket could not be saved). */
  async remove(photos: StoredPhoto[]): Promise<void> {
    await this.storage.remove(photos.map((p) => ({ key: p.storageKey, visibility: 'private' as const })));
  }
}
