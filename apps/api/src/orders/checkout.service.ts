import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import {
  CHECKOUT_EMAIL_PATTERN,
  CHECKOUT_FIELD_MESSAGES_HE,
  CHECKOUT_LIMITS,
  CHECKOUT_PHONE_PATTERN,
  MAX_FLOOR,
  type CheckoutAddress,
  type CheckoutContact,
  type CheckoutField,
  type CheckoutPrefill,
  type CheckoutRequest,
  type CheckoutResponse,
  type ShippingMethod,
  type ShippingOption,
} from '@hg/models';
import type { ComputedLine } from '../cart/cart-lines.js';
import { computeCartLines } from '../cart/cart-lines.js';
import { deliveryEstimate } from '../cart/cart-rules.js';
import { CartService } from '../cart/cart.service.js';
import { CatalogService } from '../catalog/catalog.service.js';
import { OrderShippingMethod, OrderStatus } from '../generated/prisma/client.js';
import { PaymentsService } from '../payments/payments.service.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { couponProblemMessageHe } from '../promotions/discount-engine.js';
import { discountInfo, discountLines, PromotionsService } from '../promotions/promotions.service.js';
import type { ShipmentItem } from '../shipping/shipping-provider.js';
import { ShippingNotConfiguredError, ShippingService } from '../shipping/shipping.service.js';
import { lockCart, lockVariants, lockWelcome } from './locks.js';
import {
  cartChanged,
  couponInvalid,
  emptyCart,
  fieldError,
  invalidInput,
  priceChanged,
  promotionEndedError,
  shippingUnavailable,
  shortage,
} from './order-errors.js';
import { reservedUntil } from './order-number.js';
import { listAddresses } from '../customers/address-view.js';

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
 *     `insufficient_stock` with the line and its new limit). The shipping is quoted once more from these locked lines
 *     (a price-list change in between is picked up). The one discount (spec §6) is recomputed from the locked lines
 *     and the cart's coupon (read under the cart lock, so it cannot change meanwhile): a coupon used up since the
 *     customer saw it → 409 `coupon_invalid`; any other change (a promotion that ended, a coupon that expired) shows
 *     in the total. When the total the customer saw (`expectedTotal`, required) differs from the recomputed one
 *     (subtotal − discount + shipping), nothing is created: 409 `price_changed` with the new total. Then create
 *     the order, its items, the discount snapshot and the reservation. A usage limit counts paid orders plus live
 *     pending orders of other carts (spec §6); the limited promotion rows are locked last, so two checkouts cannot both
 *     take a coupon's last use. A pending order whose reservation ran out no longer holds a use, but if it is paid
 *     late it is honored and counted, even past the limit (Review Focus 5). `shown` / top category come from the catalog snapshot, which admin
 *     writes invalidate at once in this process (a multi-process deploy would see it up to 60 s late — Phase 9).
 *  4. After commit: ask the payment provider for a payment page and record the payment (PaymentsService).
 *
 * With a customer session (spec §6.4) the order stores `customerId`; a guest order never does (decision 77). The
 * welcome benefit (decision 79) is a candidate for an account without a paid order. Its transaction first takes the
 * account's advisory lock (`lockWelcome`, before the cart lock), so two checkouts of one account run one after the
 * other: the second sees the first's pending order holding the benefit and, when the customer saw it, gets 409
 * `promotion_ended` instead of a second welcome discount.
 */
@Injectable()
export class CheckoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cart: CartService,
    private readonly catalog: CatalogService,
    private readonly shipping: ShippingService,
    private readonly payments: PaymentsService,
    private readonly promotions: PromotionsService,
  ) {}

  async checkout(
    token: string | undefined,
    body: unknown,
    customerId: string | null = null,
  ): Promise<CheckoutResponse> {
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
    await this.quote(toShipment(quoted), input);

    // 3. Lock, re-verify, create.
    const order = await this.prisma.$transaction(
      async (tx) => {
        // The account's lock comes first (welcome → cart → orders → variants → promotions, locks.ts).
        if (customerId) await lockWelcome(tx, customerId);
        if (!(await lockCart(tx, cart.id))) throw emptyCart();
        const { couponCode } = await tx.cart.findUniqueOrThrow({
          where: { id: cart.id },
          select: { couponCode: true },
        });
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

        // Quoted from the locked lines: the price list may have changed since the unlocked quote above.
        const option = await this.quote(toShipment(lines), input);
        // Never null: there is at least one line.
        const estimate = deliveryEstimate(lines.map((l) => ({ ...l, available: true })));
        if (!estimate) throw emptyCart();
        const subtotal = lines.reduce((sum, l) => sum + l.unitPrice * l.storedQuantity, 0);
        // The one discount of the order (decision 70), on the locked lines at their current prices. The limited
        // promotions are locked last (cart → orders → variants → promotions), so their uses — paid plus live
        // pending orders of other carts (this cart's were just expired) — hold until commit (spec §6).
        const customer = await this.promotions.welcomeCustomer(tx, customerId);
        await this.promotions.lockLimited(tx, couponCode, customer?.hasPaidOrder === false);
        const evaluated = await this.promotions.evaluate(
          tx,
          discountLines(lines, (l) => l.storedQuantity),
          couponCode,
          { cartId: cart.id, customer },
        );
        if (evaluated.couponProblem === 'exhausted')
          throw couponInvalid(couponProblemMessageHe('exhausted', evaluated.coupon));
        const discount = evaluated.applied?.amount ?? 0;
        const info = discountInfo(evaluated);
        const total = subtotal - discount + option.total;
        // Another order of the account took the welcome benefit meanwhile (one at a time, decision 79).
        if (input.expectedTotal !== total && evaluated.welcomeHeld) throw promotionEndedError();
        if (input.expectedTotal !== total) throw priceChanged(total);
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
            discountInfo: info ? { ...info } : undefined,
            promotionId: evaluated.promotion?.id ?? null,
            total,
            deliveryEstimate: estimate,
            paymentProvider: this.payments.providerCode,
            shippingProvider: this.shipping.providerCode,
            cartId: cart.id,
            customerId,
            marketingConsent: input.marketingConsent === true,
            marketingConsentAt: input.marketingConsent ? new Date() : null,
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

  /** GET /api/checkout/prefill: the account's contact and saved addresses, default first (spec §6.4). */
  async prefill(customerId: string): Promise<CheckoutPrefill> {
    const customer = await this.prisma.customer.findUniqueOrThrow({ where: { id: customerId } });
    return {
      contact: { fullName: customer.fullName, phone: customer.phone, email: customer.email },
      addresses: await listAddresses(this.prisma, customerId),
    };
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

/** The Hebrew field messages and limits are shared with the storefront's form (`@hg/models`). */
export const MESSAGES = CHECKOUT_FIELD_MESSAGES_HE;
const L = CHECKOUT_LIMITS;
const METHODS: readonly ShippingMethod[] = ['curbside', 'full_service'];

/** Validates and normalizes a checkout request; throws 400 `{ code: 'invalid_field', field, messageHe }` on the first bad field. */
export function parseCheckoutRequest(body: unknown): CheckoutRequest {
  const root = record(body);
  const contact = record(root.contact);
  const address = record(root.address);
  const fail = (field: CheckoutField) => fieldError(field, MESSAGES[field]);

  const fullName = text(contact.fullName);
  if (fullName === null || fullName.length < L.fullNameMin || fullName.length > L.fullNameMax)
    throw fail('contact.fullName');
  const phone = typeof contact.phone === 'string' ? contact.phone.replace(/[\s-]/g, '') : null;
  if (phone === null || !CHECKOUT_PHONE_PATTERN.test(phone)) throw fail('contact.phone');
  const email = text(contact.email);
  if (email === null || email.length > L.emailMax || !CHECKOUT_EMAIL_PATTERN.test(email)) throw fail('contact.email');

  const checkedAddress = parseCheckoutAddress(address);

  if (typeof root.method !== 'string' || !METHODS.includes(root.method as ShippingMethod)) throw fail('method');
  if (root.acceptTerms !== true) throw fail('acceptTerms');

  const checkedContact: CheckoutContact = { fullName, phone, email };
  // Required: an order is never charged at a total the customer did not see (checked after the form fields, so a
  // form error still names its field).
  const expectedTotal = root.expectedTotal;
  if (typeof expectedTotal !== 'number' || !Number.isSafeInteger(expectedTotal) || expectedTotal < 0)
    throw invalidInput();
  const marketingConsent = root.marketingConsent ?? false;
  if (typeof marketingConsent !== 'boolean') throw invalidInput();
  return {
    contact: checkedContact,
    address: checkedAddress,
    method: root.method as ShippingMethod,
    acceptTerms: true,
    expectedTotal,
    marketingConsent,
  };
}

/**
 * Validates a delivery address (spec §5.1): the checkout's and the account's saved addresses (spec §6.3) follow the
 * same rules. Throws 400 `{ code: 'invalid_field', field: 'address.…', messageHe }` on the first bad field. Whether
 * the locality exists is the caller's check.
 */
export function parseCheckoutAddress(raw: unknown): CheckoutAddress {
  const address = record(raw);
  const fail = (field: CheckoutField) => fieldError(field, MESSAGES[field]);
  const { localityId, floor, hasElevator } = address;
  if (typeof localityId !== 'number' || !Number.isSafeInteger(localityId) || localityId < 1)
    throw fail('address.localityId');
  const street = text(address.street);
  if (!street || street.length > L.streetMax) throw fail('address.street');
  const houseNumber = text(address.houseNumber);
  if (!houseNumber || houseNumber.length > L.houseNumberMax) throw fail('address.houseNumber');
  const apartment = optionalText(address.apartment, L.apartmentMax);
  if (apartment === undefined) throw fail('address.apartment');
  if (typeof floor !== 'number' || !Number.isInteger(floor) || floor < 0 || floor > MAX_FLOOR)
    throw fail('address.floor');
  if (typeof hasElevator !== 'boolean') throw fail('address.hasElevator');
  const notes = optionalText(address.notes, L.notesMax);
  if (notes === undefined) throw fail('address.notes');
  return { localityId, street, houseNumber, apartment, floor, hasElevator, notes };
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
