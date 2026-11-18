import { Controller, Post, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CONTENT_IMAGE, type AdminContentImage } from '@hg/models';
import type { RequestMeta } from '../auth/auth.service.js';
import {
  Admin,
  AdminAuthGuard,
  ClientMeta,
  RequirePermission,
  SameOriginGuard,
  type AdminContext,
} from '../auth/guards.js';
import { ContentImagesService } from './content-images.service.js';

/** The part of multer's file object we use. */
type UploadedBytes = { buffer: Buffer };

/**
 * Content photo upload (Phase 8 §6): multipart field `file`, content.manage. Uploads over the size limit are cut off
 * by multer (413); a file that is not a usable photo is 400 `invalid` on `file` with the reason in `value`.
 */
@Controller('admin/content/images')
@UseGuards(SameOriginGuard, AdminAuthGuard)
@RequirePermission('content.manage')
export class ContentImagesController {
  constructor(private readonly images: ContentImagesService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: CONTENT_IMAGE.maxBytes, files: 1, fields: 5 } }))
  upload(
    @UploadedFile() file: UploadedBytes | undefined,
    @Admin() admin: AdminContext,
    @ClientMeta() client: RequestMeta,
  ): Promise<AdminContentImage> {
    return this.images.upload(file?.buffer ?? Buffer.alloc(0), { actorId: admin.user.id, ip: client.ip });
  }
}
