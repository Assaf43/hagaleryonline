import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type {
  CheckoutAddress,
  CheckoutContact,
  CheckoutRequest,
  CheckoutResponse,
  ShippingMethod,
  ShippingOption,
} from '@hg/models';
import type { ComputedLine } from '../cart/cart-lines.js';
import { computeCartLines } from '../cart/cart-lines.js';
import { deliveryEstimate } from '../cart/cart-rules.js';
import { CartService } from '../cart/cart.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { OrderShippingMethod, OrderStatus } from '../generated/prisma/client.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import type { ShipmentItem } from '../shipping/shipping-provider.js';
import { MAX_FLOOR } from '../shipping/shipping-rules.js';
import { ShippingNotConfiguredError, ShippingService } from '../shipping/shipping.service.js';
import { lockCart, lockVariants } from './locks.js';
import { cartChanged, emptyCart, fieldError, shippingUnavailable, shortage } from './order-errors.js';
import { reservedUntil } from './order-number.js';

export const ORDER_METHOD: Record<ShippingMethod, OrderShippingMethod> = {
  curbside: OrderShippingMethod.CURBSIDE,
  full_service: OrderShippingMethod.FULL_SERVICE,
};

/**
 * Checkout (spec §5.2, CHK-01–04): turns the cart of the cookie into an order that holds its stock for 20 minutes,
 * then opens the payment provider's page.
 *
 * Order of operations — locks are held only around the stock check and the insert:
 *  1. Validate the request (400 with the first invalid field) and resolve the cart and the locality.
 *  2. Without locks: recompute the cart lines (computeCartLines, the same code as the cart view) and quote shipping
 *     for them through ShippingService.quote (the only way to price shipping; 503 when it is not configured).
 *  3. One transaction: lock the cart row (one checkout per cart at a time), expire this cart's earlier pending
 *     orders (a customer who comes back from the payment page does not block their own stock), lock the variant
 *     rows in id order, recompute the lines under the locks — fresh prices, fresh available stock — and check them:
 *     the lines must be the ones that were quoted (else 409 `cart_changed`) and each must fit its limit (else 409
 *     `insufficient_stock` with the line and its new limit). Then create the order, its items and the reservation.
 *  4. After commit: ask the payment provider for a payment page and record the payment (PaymentsService).
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly catalog: CatalogService,
    private readonly shipping: ShippingService,
    private readonly payments: PaymentsService,
  ) {}

  async checkout(token: string | undefined, body: unknown): Promise<CheckoutResponse> {
    // 1. Input, cart and locality.
    const input = parseCheckoutRequest(body);
    const cart = await this.cart.resolve(token);
    if (!cart) throw emptyCart();
    const locality = await this.prisma.locality.findUnique({ where: { id: input.address.localityId } });
    if (!locality) throw fieldError('address.localityId', MESSAGES['address.localityId']);
    const snapshot = await this.catalog.snapshot();

    // 2. Lines and shipping quote, without locks.
    const quoted = orderable(await computeCartLines(this.prisma, cart.id, snapshot));
    if (quoted.length === 0) throw emptyCart();
    const option = await this.quote(toShipment(quoted), input);

    // 3. Lock, re-verify, create.
    const order = await this.prisma.$transaction(
      async (tx) => {
        if (!(await lockCart(tx, cart.id))) throw emptyCart();
        await tx.order.updateMany({
          where: { cartId: cart.id, status: OrderStatus.PENDING_PAYMENT },
          data: { status: OrderStatus.EXPIRED },
        });
        const variantIds = (
          await tx.cartItem.findMany({ where: { cartId: cart.id }, select: { variantId: true } })
        ).map((i) => i.variantId);
        await lockVariants(tx, variantIds);

        const lines = orderable(await computeCartLines(tx, cart.id, snapshot));
        // Every validated line must be under its lock: a line added to the cart after the ids were read is not,
        // so the cart changed under us (fail closed rather than validate it unlocked).
        const locked = new Set(variantIds);
        if (lines.some((l) => !locked.has(l.variantId))) throw cartChanged();
        if (!sameShipment(toShipment(lines), toShipment(quoted))) throw cartChanged();
        const short = lines.find((l) => l.storedQuantity > l.limit);
        if (short) throw shortage(short.variantId, short.limit);

        // Never null: there is at least one line.
        const estimate = deliveryEstimate(lines.map((l) => ({ ...l, available: true })));
        if (!estimate) throw emptyCart();
        const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.storedQuantity, 0);
        // Phase 4d: the one discount of the order (decision 70) is computed and re-checked here.
        const discount = 0;
        return tx.order.create({
          data: {
            publicToken: randomBytes(32).toString('base64url'),
            status: OrderStatus.PENDING_PAYMENT,
            contact: { ...input.contact },
            address: { ...input.address, localityNameHe: locality.nameHe },
            method: ORDER_METHOD[input.method],
            shippingTotal: option.total,
            shippingLines: option.lines.map((l) => ({ ...l })),
            subtotal,
            discount,
            total: subtotal - discount + option.total,
            deliveryEstimate: estimate,
            paymentProvider: this.payments.providerCode,
            shippingProvider: this.shipping.providerCode,
            cartId: cart.id,
            reservedUntil: reservedUntil(),
            items: {
              create: lines.map((l) => ({
                variantId: l.variantId,
                sku: l.sku,
                modelName: l.modelName,
                nameHe: l.nameHe,
                optionLabels: l.optionLabels,
                unitPrice: l.unitPrice,
                quantity: l.storedQuantity,
                lineTotal: l.unitPrice * l.storedQuantity,
              })),
            },
          },
          select: { id: true, number: true, total: true, contact: true },
        });
      },
      { timeout: 15_000 },
    );

    // 4. The provider call, outside the transaction.
    return { redirectUrl: await this.payments.openPaymentPage(order) };
  }

  /** The chosen method's quote; 503 when the price list is not configured. */
  private async quote(items: ShipmentItem[], input: CheckoutRequest): Promise<ShippingOption> {
    const { localityId, floor, hasElevator } = input.address;
    try {
      const quote = await this.shipping.quote(items, { localityId, floor, hasElevator });
      const option = quote.methods.find((m) => m.method === input.method);
      if (!option) throw shippingUnavailable();
      return option;
    } catch (e) {
      if (e instanceof ShippingNotConfiguredError) throw shippingUnavailable();
      throw e;
    }
  }
}

/**
 * The lines an order is made of: every line still shown on the site, with the quantity in the cart. A hidden line
 * is left out (it is no longer for sale, and the cart says so); a shown line asking for more than its limit —
 * including a sold-out one — is a shortage, never silently dropped or reduced.
 */
function orderable(lines: ComputedLine[]): ComputedLine[] {
  return lines.filter((l) => l.shown && l.topCategoryId !== null);
}

function toShipment(lines: ComputedLine[]): ShipmentItem[] {
  return lines.map((l) => ({ variantId: l.variantId, topCategoryId: l.topCategoryId!, quantity: l.storedQuantity }));
}

function sameShipment(a: ShipmentItem[], b: ShipmentItem[]): boolean {
  const key = (items: ShipmentItem[]) =>
    items
      .map((i) => `${i.variantId}:${i.topCategoryId}:${i.quantity}`)
      .sort()
      .join(',');
  return key(a) === key(b);
}

// ---------- Validation (spec §5.1) ----------

export const MESSAGES = {
  'contact.fullName': 'יש למלא שם מלא (2–80 תווים)',
  'contact.phone': 'יש להזין מספר טלפון נייד תקין, למשל 050-1234567',
  'contact.email': 'יש להזין כתובת דוא״ל תקינה',
  'address.localityId': 'יש לבחור יישוב מהרשימה',
  'address.street': 'יש למלא רחוב (עד 80 תווים)',
  'address.houseNumber': 'יש למלא מספר בית (עד 10 תווים)',
  'address.apartment': 'מספר הדירה ארוך מדי (עד 10 תווים)',
  'address.floor': 'יש להזין קומה בין 0 ל־60',
  'address.hasElevator': 'יש לציין אם יש מעלית',
  'address.notes': 'ההערות לשליח ארוכות מדי (עד 500 תווים)',
  method: 'יש לבחור שיטת משלוח',
  acceptTerms: 'יש לאשר את תנאי השימוש',
} as const;

const PHONE = /^05\d{8}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const METHODS: readonly ShippingMethod[] = ['curbside', 'full_service'];

/** Validates and normalizes a checkout request; throws 400 `{ code: 'invalid_field', field, messageHe }` on the first bad field. */
export function parseCheckoutRequest(body: unknown): CheckoutRequest {
  const root = record(body);
  const contact = record(root.contact);
  const address = record(root.address);
  const fail = (field: keyof typeof MESSAGES) => fieldError(field, MESSAGES[field]);

  const fullName = text(contact.fullName);
  if (fullName === null || fullName.length < 2 || fullName.length > 80) throw fail('contact.fullName');
  const phone = typeof contact.phone === 'string' ? contact.phone.replace(/[\s-]/g, '') : null;
  if (phone === null || !PHONE.test(phone)) throw fail('contact.phone');
  const email = text(contact.email);
  if (email === null || email.length > 254 || !EMAIL.test(email)) throw fail('contact.email');

  const { localityId, floor, hasElevator } = address;
  if (typeof localityId !== 'number' || !Number.isSafeInteger(localityId) || localityId < 1)
    throw fail('address.localityId');
  const street = text(address.street);
  if (!street || street.length > 80) throw fail('address.street');
  const houseNumber = text(address.houseNumber);
  if (!houseNumber || houseNumber.length > 10) throw fail('address.houseNumber');
  const apartment = optionalText(address.apartment, 10);
  if (apartment === undefined) throw fail('address.apartment');
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0 || floor > MAX_FLOOR)
    throw fail('address.floor');
  if (typeof hasElevator !== 'boolean') throw fail('address.hasElevator');
  const notes = optionalText(address.notes, 500);
  if (notes === undefined) throw fail('address.notes');

  if (typeof root.method !== 'string' || !METHODS.includes(root.method as ShippingMethod)) throw fail('method');
  if (root.acceptTerms !== true) throw fail('acceptTerms');

  const checkedContact: CheckoutContact = { fullName, phone, email };
  const checkedAddress: CheckoutAddress = { localityId, street, houseNumber, apartment, floor, hasElevator, notes };
  return { contact: checkedContact, address: checkedAddress, method: root.method as ShippingMethod, acceptTerms: true };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Trimmed string, or null when not a string. */
function text(value: unknown): string | null {
  return typeof value === 'string' ? value.trim() : null;
}

/** Optional trimmed text: null when missing or blank, undefined when invalid (not a string or too long). */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed.length > max) return undefined;
  return trimmed || null;
}
