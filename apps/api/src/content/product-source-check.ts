import type { ProductSource } from '@hg/models';
import {
  PromotionKind as DbPromotionKind,
  PromotionTarget as DbPromotionTarget,
  type Prisma,
} from '../generated/prisma/client.js';
import { invalid, invalidSource } from './content-errors.js';
import { sameSource } from './product-source.js';

type Tx = Prisma.TransactionClient;

/**
 * A promotion a product source may name (Phase 8 §9 "Promotion source"): automatic, on categories or products (never
 * the whole order) and not members-only. Whether it is live now is not checked on save: an ended or inactive one is
 * accepted and the row or grid just shows nothing (`promotionUsable`).
 */
export function promotionSourceAllowed(promotion: {
  kind: DbPromotionKind;
  target: DbPromotionTarget;
  membersOnly: boolean;
}): boolean {
  return (
    promotion.kind === DbPromotionKind.AUTOMATIC &&
    promotion.target !== DbPromotionTarget.ORDER &&
    !promotion.membersOnly
  );
}

/**
 * The references of one product source on save, with the home page's rules: manual products must exist unless the row
 * already held them (`before`); when the source did not change (`sameSource`) its category, room or promotion is
 * accepted as it is (a reference that went away later never blocks a save; the admin marks it); otherwise a category
 * or room must exist (400 `invalid` on `<field>.id`) and a promotion must be allowed (400 `invalid_source` on `<field>`).
 */
export async function checkProductSource(
  tx: Tx,
  source: ProductSource,
  before: ProductSource | undefined,
  field: string,
): Promise<void> {
  if (source.kind === 'manual') {
    const held = new Set(before?.kind === 'manual' ? before.productIds : []);
    const wanted = source.productIds.filter((id) => !held.has(id));
    const found = wanted.length
      ? await tx.product.findMany({ where: { id: { in: wanted } }, select: { id: true } })
      : [];
    if (found.length !== new Set(wanted).size) throw invalid(`${field}.productIds`);
  }
  if (before && sameSource(before, source)) return;
  if (source.kind === 'category') {
    const row = await tx.category.findUnique({ where: { id: source.id }, select: { id: true } });
    if (!row) throw invalid(`${field}.id`);
  }
  if (source.kind === 'room') {
    const row = await tx.room.findUnique({ where: { id: source.id }, select: { id: true } });
    if (!row) throw invalid(`${field}.id`);
  }
  if (source.kind === 'promotion') {
    const promotion = await tx.promotion.findUnique({
      where: { id: source.id },
      select: { kind: true, target: true, membersOnly: true },
    });
    if (!promotion || !promotionSourceAllowed(promotion)) throw invalidSource(field);
  }
}
