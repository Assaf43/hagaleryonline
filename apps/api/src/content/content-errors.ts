import { HttpException, HttpStatus } from '@nestjs/common';
import type { ContentErrorCode, ImageUploadProblem } from '@hg/models';

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
/** An upload that is not a usable photo: 400 `invalid` on `file`, the reason in `value` (as product photos). */
export const invalidImage = (problem: ImageUploadProblem) =>
  new ContentError(HttpStatus.BAD_REQUEST, 'invalid', { field: 'file', value: problem });
/** A banner a home section uses cannot be deleted (409); `sections` names the sections (`homeSectionName`). */
export const bannerInUse = (sections: string[]) => new ContentError(HttpStatus.CONFLICT, 'banner_in_use', { sections });
/** A product source naming a promotion that is not automatic, is on the whole order or is members-only (400). */
export const invalidSource = (field: string) => new ContentError(HttpStatus.BAD_REQUEST, 'invalid_source', { field });
