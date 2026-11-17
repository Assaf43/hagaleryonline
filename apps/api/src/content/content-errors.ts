import { HttpException, HttpStatus } from '@nestjs/common';
import type { ContentErrorCode } from '@hg/models';

/** Content errors carry a machine-readable code and the field at fault; the admin app shows the Hebrew text. */
export class ContentError extends HttpException {
  constructor(status: HttpStatus, code: ContentErrorCode, extra: Record<string, unknown> = {}) {
    super({ statusCode: status, code, ...extra }, status);
  }
}

export const invalid = (field: string) => new ContentError(HttpStatus.BAD_REQUEST, 'invalid', { field });
export const invalidLink = (field: string) => new ContentError(HttpStatus.BAD_REQUEST, 'invalid_link', { field });
export const conflict = () => new ContentError(HttpStatus.CONFLICT, 'conflict');
export const notFound = () => new ContentError(HttpStatus.NOT_FOUND, 'not_found');
export const slugTaken = () => new ContentError(HttpStatus.CONFLICT, 'slug_taken', { field: 'slug' });
/** A system page cannot be deleted (409) or get another slug / be unpublished (400 with the field). */
export const systemPageDelete = () => new ContentError(HttpStatus.CONFLICT, 'system_page');
export const systemPageField = (field: 'slug' | 'published') =>
  new ContentError(HttpStatus.BAD_REQUEST, 'system_page', { field });
