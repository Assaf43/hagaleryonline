import { HttpException, HttpStatus, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { CartErrorCode, CartLine, CartNotice, CartView, FulfillmentMode, OptionAxis } from '@hg/models';
import { FULFILLMENT } from '../catalog/catalog.repository.js';
import type { CatalogSnapshot, SnapshotProduct, SnapshotVariant } from '../catalog/catalog-snapshot.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { insertSizeAxis, SIZE_AXIS, sizeAxis } from '../catalog/size-axis.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { availableStock } from './available-stock.js';
import { clampQuantity, deliveryEstimate, lineLimit } from './cart-rules.js';
import { CART_TTL_MS, hashToken, newToken } from './cart-token.js';

const CLEANUP_EVERY_MS = 24 * 60 * 60_000;

/** A cart view plus the token the cookie should carry (null: there is no cart). */
export interface CartResult {
  view: CartView;
  token: string | null;
}

export class CartError extends HttpException {
  constructor(status: HttpStatus, code: CartErrorCode) {
    super({ statusCode: status, code }, status);
  }
}

const notFound = () => new CartError(HttpStatus.NOT_FOUND, 'not_found');
const unavailable = () => new CartError(HttpStatus.CONFLICT, 'unavailable');

const EMPTY_VIEW: CartView = {
  lines: [],
  itemCount: 0,
  subtotal: 0,
  deliveryEstimate: null,
  notices: [],
  shippingFrom: null,
  discount: null,
};

/**
 * Server-side cart (spec §3.1, decision 68, CRT-02, CRT-04). Shown data and visibility come from the catalog
 * snapshot; price and stock are read fresh from the database on every request, so totals are always the server's.
 */
@Injectable()
export class CartService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CartService.name);
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
  ) {}

  onModuleInit(): void {
    const cleanup = () =>
      this.deleteStaleCarts().catch((error: unknown) => this.logger.error('Cart cleanup failed', error));
    void cleanup();
    this.cleanupTimer = setInterval(() => void cleanup(), CLEANUP_EVERY_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Deletes carts unused for 30 days (their lines go with them). */
  async deleteStaleCarts(now = new Date()): Promise<number> {
    const { count } = await this.prisma.cart.deleteMany({ where: { updatedAt: { lt: staleBefore(now) } } });
    return count;
  }

  /** Never creates a cart. */
  async read(token: string | undefined): Promise<CartResult> {
    const cart = await this.resolve(token);
    if (!cart) return { view: EMPTY_VIEW, token: null };
    return { view: await this.buildView(cart.id, []), token: token! };
  }

  /** Adds to the variant's line (creating the cart on the first add), clamped to the line limit. */
  async add(token: string | undefined, variantId: number, quantity: number): Promise<CartResult> {
    const orderable = await this.orderable(variantId);
    if (!orderable) throw notFound();
    const { price, limit, fulfillment } = orderable;
    if (limit < 1) throw unavailable();

    let cart = await this.resolve(token);
    let liveToken = token;
    if (!cart || !liveToken) {
      liveToken = newToken();
      cart = await this.prisma.cart.create({ data: { tokenHash: hashToken(liveToken) } });
    }
    const key = { cartId: cart.id, variantId };
    const existing = await this.prisma.cartItem.findUnique({ where: { cartId_variantId: key } });
    const wanted = (existing?.quantity ?? 0) + quantity;
    const next = clampQuantity(wanted, limit);
    // Adding again means the customer saw the current price: it becomes the line's reference price.
    await this.prisma.cartItem.upsert({
      where: { cartId_variantId: key },
      create: { ...key, quantity: next, unitPriceAtAdd: price },
      update: { quantity: next, unitPriceAtAdd: price },
    });
    const notices = next < wanted ? [clampedNotice(variantId, fulfillment, limit)] : [];
    return { view: await this.buildView(cart.id, notices), token: liveToken };
  }

  /** Sets the quantity of an existing line, clamped to the line limit. */
  async update(token: string | undefined, variantId: number, quantity: number): Promise<CartResult> {
    const cart = await this.resolve(token);
    const item =
      cart && (await this.prisma.cartItem.findUnique({ where: { cartId_variantId: { cartId: cart.id, variantId } } }));
    if (!cart || !item) throw notFound();
    // The line exists, so a variant that is no longer shown is unavailable rather than unknown.
    const orderable = await this.orderable(variantId);
    if (!orderable || orderable.limit < 1) throw unavailable();
    const { limit, fulfillment } = orderable;
    const next = clampQuantity(quantity, limit);
    await this.prisma.cartItem.update({
      where: { cartId_variantId: { cartId: cart.id, variantId } },
      data: { quantity: next },
    });
    const notices = next < quantity ? [clampedNotice(variantId, fulfillment, limit)] : [];
    return { view: await this.buildView(cart.id, notices), token: token! };
  }

  /** Removes a line; removing a line that is not there is not an error. */
  async remove(token: string | undefined, variantId: number): Promise<CartResult> {
    const cart = await this.resolve(token);
    if (!cart) return { view: EMPTY_VIEW, token: null };
    await this.prisma.cartItem.deleteMany({ where: { cartId: cart.id, variantId } });
    return { view: await this.buildView(cart.id, []), token: token! };
  }

  /** The cart of a cookie token, marked as used; an expired cart is deleted and reads as none. */
  private async resolve(token: string | undefined): Promise<{ id: string } | null> {
    if (!token) return null;
    const now = new Date();
    const cart = await this.prisma.cart.findUnique({
      where: { tokenHash: hashToken(token) },
      select: { id: true, updatedAt: true },
    });
    if (!cart) return null;
    if (cart.updatedAt < staleBefore(now)) {
      await this.prisma.cart.deleteMany({ where: { id: cart.id } });
      return null;
    }
    await this.prisma.cart.update({ where: { id: cart.id }, data: { updatedAt: now } });
    return { id: cart.id };
  }

  /** A shown variant's current price, fulfillment and line limit; null when it is not shown. */
  private async orderable(variantId: number) {
    const snapshot = await this.catalog.snapshot();
    const shown = findShown(snapshot, variantId);
    const variant = await this.prisma.variant.findUnique({
      where: { id: variantId },
      select: { price: true, fulfillment: true, active: true },
    });
    if (!shown || !variant?.active) return null;
    const fulfillment = FULFILLMENT[variant.fulfillment];
    const stock = (await availableStock(this.prisma, [variantId])).get(variantId) ?? 0;
    return { price: variant.price, fulfillment, limit: lineLimit(fulfillment, stock) };
  }

  /** Recomputes every line (spec §3.1): price changes, limits (clamped and saved) and visibility. */
  private async buildView(cartId: string, requestNotices: CartNotice[]): Promise<CartView> {
    const [snapshot, items] = await Promise.all([
      this.catalog.snapshot(),
      this.prisma.cartItem.findMany({
        where: { cartId },
        orderBy: [{ addedAt: 'asc' }, { variantId: 'asc' }],
        include: {
          variant: {
            select: {
              price: true,
              compareAtPrice: true,
              fulfillment: true,
              leadTimeDays: true,
              active: true,
              product: { select: { slug: true, modelName: true, nameHe: true } },
            },
          },
        },
      }),
    ]);
    const stock = await availableStock(
      this.prisma,
      items.map((i) => i.variantId),
    );

    const lines: CartLine[] = [];
    const notices: CartNotice[] = [...requestNotices];
    for (const item of items) {
      const v = item.variant;
      const fulfillment = FULFILLMENT[v.fulfillment];
      const shown = v.active ? findShown(snapshot, item.variantId) : undefined;
      const limit = shown ? lineLimit(fulfillment, stock.get(item.variantId) ?? 0) : 0;
      const available = limit >= 1;
      let quantity = item.quantity;

      if (!available) {
        notices.push({
          variantId: item.variantId,
          kind: 'unavailable',
          messageHe: `${v.product.modelName} לא זמין יותר`,
        });
      } else {
        if (quantity > limit) {
          quantity = limit;
          await this.prisma.cartItem.update({
            where: { cartId_variantId: { cartId, variantId: item.variantId } },
            data: { quantity },
          });
          notices.push(clampedNotice(item.variantId, fulfillment, limit));
        }
        if (v.price !== item.unitPriceAtAdd)
          notices.push({
            variantId: item.variantId,
            kind: 'price_changed',
            messageHe: `המחיר של ${v.product.modelName} עודכן`,
          });
      }

      lines.push({
        variantId: item.variantId,
        productSlug: v.product.slug,
        modelName: v.product.modelName,
        nameHe: v.product.nameHe,
        optionLabels: shown ? optionLabels(snapshot, shown.product, shown.variant) : [],
        image: shown ? lineImage(shown.product, shown.variant) : null,
        unitPrice: v.price,
        compareAtPrice: v.compareAtPrice,
        quantity,
        lineTotal: v.price * quantity,
        maxQuantity: limit,
        fulfillment,
        leadTimeDays: v.leadTimeDays,
        available,
      });
    }

    const counted = lines.filter((l) => l.available);
    return {
      lines,
      itemCount: counted.reduce((sum, l) => sum + l.quantity, 0),
      subtotal: counted.reduce((sum, l) => sum + l.lineTotal, 0),
      deliveryEstimate: deliveryEstimate(lines),
      notices,
      shippingFrom: null,
      discount: null,
    };
  }
}

function staleBefore(now: Date): Date {
  return new Date(now.getTime() - CART_TTL_MS);
}

function clampedNotice(variantId: number, fulfillment: FulfillmentMode, limit: number): CartNotice {
  return {
    variantId,
    kind: 'quantity_clamped',
    messageHe: fulfillment === 'in_stock' ? `נשארו רק ${limit} במלאי` : `אפשר להזמין עד ${limit} יחידות`,
  };
}

/** The variant and its product when both are shown on the site (in the active-only snapshot). */
function findShown(
  snapshot: CatalogSnapshot,
  variantId: number,
): { product: SnapshotProduct; variant: SnapshotVariant } | undefined {
  for (const product of snapshot.products) {
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant) return { product, variant };
  }
  return undefined;
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
