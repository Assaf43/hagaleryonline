import { HttpException, HttpStatus } from '@nestjs/common';
import type { ActivationProblem, CatalogErrorCode } from '@hg/models';

/** Errors carry a machine-readable code and the field at fault; the admin app shows the Hebrew text. */
export class CatalogError extends HttpException {
  constructor(status: HttpStatus, code: CatalogErrorCode, extra: Record<string, unknown> = {}) {
    super({ statusCode: status, code, ...extra }, status);
  }
}

export const invalid = (field: string, value?: string) =>
  new CatalogError(HttpStatus.BAD_REQUEST, 'invalid', { field, value });
export const duplicate = (field: string, value?: string) =>
  new CatalogError(HttpStatus.CONFLICT, 'duplicate', { field, value });
export const conflict = () => new CatalogError(HttpStatus.CONFLICT, 'conflict');
export const inUse = (field: string) => new CatalogError(HttpStatus.CONFLICT, 'in_use', { field });
export const notFound = () => new CatalogError(HttpStatus.NOT_FOUND, 'not_found');
export const incomplete = (reasons: ActivationProblem[]) =>
  new CatalogError(HttpStatus.BAD_REQUEST, 'incomplete', { reasons });
/** A product that was ordered cannot be deleted, only hidden. */
export const hasOrders = () =>
  new CatalogError(HttpStatus.CONFLICT, 'in_use', {
    field: 'orders',
    messageHe: 'למוצר יש הזמנות. אפשר רק להסתיר אותו.',
  });
/** A variant that was ordered cannot be removed from the product, only turned off. `index` is its row in the saved product. */
export const variantHasOrders = (index: number) =>
  new CatalogError(HttpStatus.CONFLICT, 'in_use', {
    field: `variants.${index}`,
    messageHe: 'לווריאנט יש הזמנות. אפשר רק לכבות אותו.',
  });
