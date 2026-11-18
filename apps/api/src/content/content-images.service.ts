import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { CONTENT_IMAGE, type AdminContentImage } from '@hg/models';
import { AuditService } from '../audit/audit.service.js';
import { CacheStore } from '../cache/cache-store.js';
import { copyKey, ImageRejected, processImage } from '../media/image-processor.js';
import { imageFiles, originalKey } from '../media/image-urls.js';
import { StorageProvider } from '../media/storage.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { recordContentChange, type ContentMeta } from './content-audit.js';
import { contentImageRef } from './content-image-ref.js';
import { invalidImage } from './content-errors.js';
import { CONTENT_CACHE_PREFIX } from './content.service.js';

/**
 * Content photos (Phase 8 §6): checked by their content and processed like product photos (`processImage`: upright,
 * sRGB, no metadata, WebP + AVIF) in `CONTENT_IMAGE.widths` with a 1200 px minimum long side; the original is kept
 * privately. A photo is stored on its own and then picked by a banner (or, in 8c, a landing page); nothing deletes
 * photos in this phase.
 */
@Injectable()
export class ContentImagesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cache: CacheStore,
    private readonly storage: StorageProvider,
  ) {}

  async upload(file: Buffer, meta: ContentMeta): Promise<AdminContentImage> {
    let processed;
    try {
      processed = await processImage(file, { widths: CONTENT_IMAGE.widths, minLongSide: CONTENT_IMAGE.minLongSide });
    } catch (e) {
      if (e instanceof ImageRejected) throw invalidImage(e.problem);
      throw e;
    }

    const storageKey = `content/${randomBytes(9).toString('base64url')}`;
    const widths = processed.copies.map((c) => c.width);
    try {
      await this.storage.put(originalKey(storageKey, processed.originalExt), file, 'private');
      for (const copy of processed.copies) {
        await this.storage.put(copyKey(storageKey, copy.width, 'webp'), copy.webp, 'public');
        await this.storage.put(copyKey(storageKey, copy.width, 'avif'), copy.avif, 'public');
      }
      const image = await this.prisma.$transaction(async (tx) => {
        const row = await tx.contentImage.create({
          data: {
            storageKey,
            widths,
            width: processed.width,
            height: processed.height,
            originalExt: processed.originalExt,
          },
        });
        await recordContentChange(this.audit, tx, meta, 'content.image.create', 'content_image', row.id, null, {
          מידות: `${row.width}×${row.height}`,
          סוג: row.originalExt,
        });
        return row;
      });
      return { id: image.id, image: contentImageRef(this.storage, image, '') };
    } catch (e) {
      await this.storage.remove(imageFiles({ storageKey, widths })).catch(() => undefined);
      throw e;
    } finally {
      // Nothing public uses a new photo yet; cleared anyway, like every content write.
      await this.cache.invalidate(CONTENT_CACHE_PREFIX);
    }
  }
}
