import type { FulfillmentMode, ImageRef, OptionAxis } from '@hg/models';
import { FULFILLMENT } from '../catalog/catalog.repository.js';
import type { CatalogSnapshot, SnapshotProduct, SnapshotVariant } from '../catalog/catalog-snapshot.js';
import { insertSizeAxis, SIZE_AXIS, sizeAxis } from '../catalog/size-axis.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { ShipmentItem } from '../shipping/shipping-provider.js';
import { availableStock } from './available-stock.js';
import { lineLimit } from './cart-rules.js';

/**
 * One cart line recomputed from the database and the catalog snapshot: the current price, the line limit from the
 * available stock (stock minus active reservations) and whether it can be bought at all. Pure reads, no writes, so
 * the cart view and checkout (inside its locking transaction) share one definition of availability.
 */
export interface ComputedLine {
  variantId: number;
  sku: string;
  /** The quantity saved in the cart. */
  storedQuantity: number;
  /** The quantity that can be bought now: the stored quantity clamped to the limit; 0 when unavailable. */
  quantity: number;
  /** Most units the line may hold right now (0 when not shown or nothing left). */
  limit: number;
  /** Shown on the site (variant active and in the active-only snapshot). */
  shown: boolean;
  /** Shown and at least one unit can be sold. */
  available: boolean;
  unitPrice: number;
  compareAtPrice: number | null;
  unitPriceAtAdd: number;
  fulfillment: FulfillmentMode;
  leadTimeDays: number;
  productSlug: string;
  modelName: string;
  nameHe: string;
  optionLabels: string[];
  image: ImageRef | null;
  /** Top-level category (shipping rates are per top-level category); null when not shown. */
  topCategoryId: number | null;
}

/** Every line of a cart in cart order (added first, then variant id), recomputed with `db` (a transaction or not). */
export async function computeCartLines(
  db: Prisma.TransactionClient | PrismaService,
  cartId: string,
  snapshot: CatalogSnapshot,
): Promise<ComputedLine[]> {
  const items = await db.cartItem.findMany({
    where: { cartId },
    orderBy: [{ addedAt: 'asc' }, { variantId: 'asc' }],
    select: {
      variantId: true,
      quantity: true,
      unitPriceAtAdd: true,
      variant: {
        select: {
          sku: true,
          price: true,
          compareAtPrice: true,
          fulfillment: true,
          leadTimeDays: true,
          active: true,
          product: { select: { slug: true, modelName: true, nameHe: true } },
        },
      },
    },
  });
  const stock = await availableStock(
    db,
    items.map((i) => i.variantId),
  );
  return items.map((item) => {
    const v = item.variant;
    const { shown, limit } = availability(snapshot, item.variantId, v, stock);
    const available = limit >= 1;
    return {
      variantId: item.variantId,
      sku: v.sku,
      storedQuantity: item.quantity,
      quantity: available ? Math.min(item.quantity, limit) : 0,
      limit,
      shown: !!shown,
      available,
      unitPrice: v.price,
      compareAtPrice: v.compareAtPrice,
      unitPriceAtAdd: item.unitPriceAtAdd,
      fulfillment: FULFILLMENT[v.fulfillment],
      leadTimeDays: v.leadTimeDays,
      productSlug: v.product.slug,
      modelName: v.product.modelName,
      nameHe: v.product.nameHe,
      optionLabels: shown ? optionLabels(snapshot, shown.product, shown.variant) : [],
      image: shown ? lineImage(shown.product, shown.variant) : null,
      topCategoryId: shown ? topCategoryId(snapshot, shown.product) : null,
    };
  });
}

/** The available lines as units to ship, with the quantity that can be bought now. */
export function shipmentItems(lines: ComputedLine[]): ShipmentItem[] {
  return lines.flatMap((l) =>
    l.available && l.topCategoryId !== null
      ? [{ variantId: l.variantId, topCategoryId: l.topCategoryId, quantity: l.quantity }]
      : [],
  );
}

/**
 * Whether a variant can be bought now: the variant and product as shown on the site (none when the variant is
 * inactive or no longer in the active-only snapshot), and how many units a line may hold (0 when not shown).
 */
export function availability(
  snapshot: CatalogSnapshot,
  variantId: number,
  variant: { active: boolean; fulfillment: keyof typeof FULFILLMENT },
  stock: Map<number, number>,
): { shown: ReturnType<typeof findShown>; limit: number } {
  const shown = variant.active ? findShown(snapshot, variantId) : undefined;
  const limit = shown ? lineLimit(FULFILLMENT[variant.fulfillment], stock.get(variantId) ?? 0) : 0;
  return { shown, limit };
}

/** The variant and its product when both are shown on the site (in the active-only snapshot). */
export function findShown(
  snapshot: CatalogSnapshot,
  variantId: number,
): { product: SnapshotProduct; variant: SnapshotVariant } | undefined {
  for (const product of snapshot.products) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return undefined;
}

/** The top-level category of a product: shipping rates are per top-level category (spec §4.1). */
function topCategoryId(snapshot: CatalogSnapshot, product: SnapshotProduct): number {
  return snapshot.categoriesById.get(product.categoryId)?.pathIds[0] ?? product.categoryId;
}

/**
 * Hebrew labels of the variant's options in the product page's axis order: variant attributes in
 * attribute order, with the synthetic size axis placed like the product page does (size-axis.ts).
 */
function optionLabels(snapshot: CatalogSnapshot, product: SnapshotProduct, variant: SnapshotVariant): string[] {
  const order = (code: string) => snapshot.attributes.get(code)?.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const codes = [...new Set(product.variants.flatMap((v) => [...v.options.keys()]))].sort(
    (a, b) => order(a) - order(b),
  );
  const size = codes.includes(SIZE_AXIS) ? null : sizeAxis(product.variants);
  const axes: OptionAxis[] = codes.map((code) => ({ code, nameHe: '', values: [] }));
  const ordered = size
    ? insertSizeAxis(axes, size.axis, { fabricOrder: snapshot.attributes.get('fabric')?.sortOrder, axisOrder: order })
    : axes;

  const labels: string[] = [];
  for (const { code } of ordered) {
    if (size && code === SIZE_AXIS) {
      const sizeCode = size.codes[product.variants.indexOf(variant)];
      const label = size.axis.values.find((v) => v.code === sizeCode)?.labelHe;
      if (label) labels.push(label);
      continue;
    }
    const value = variant.options.get(code);
    const label = value && snapshot.attributes.get(code)?.values.get(value)?.labelHe;
    if (label) labels.push(label);
  }
  return labels;
}

/** The photo of the variant's color, else the product's main photo (decision 62). */
function lineImage(product: SnapshotProduct, variant: SnapshotVariant) {
  const color = variant.options.get('color');
  return (color && product.colorImages.get(color)) || product.image;
}
