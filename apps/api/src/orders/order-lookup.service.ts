import { HttpStatus, Injectable } from '@nestjs/common';
import { ORDER_LOOKUP_MISS_HE } from '@hg/models';
import { safeEqual } from '../auth/crypto.js';
import { normalizePhone } from '../customers/contact-normalize.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { CheckoutError } from './order-errors.js';
import { confirmationPath, parseOrderNumber } from './order-number.js';

/** Longest order number text kept as a throttle key (anything longer is malformed anyway). */
const MAX_KEY_LENGTH = 32;
/**
 * Stand-ins of the same length as a stored phone (05XXXXXXXX), never equal to each other or to a real phone: the
 * compare runs even with no order or no valid phone, so an unknown number does the same work as a wrong phone.
 */
const NO_ORDER_PHONE = '----------';
const NO_GIVEN_PHONE = '__________';

/** The one answer for anything that is not a match (spec §6.5): no difference between the reasons. */
export const lookupMiss = () =>
  new CheckoutError(HttpStatus.NOT_FOUND, 'not_found', { messageHe: ORDER_LOOKUP_MISS_HE });

/** The order number as typed, without spaces; the same text for " 100001" and "100001". */
export function lookupNumberText(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/\s/g, '').slice(0, MAX_KEY_LENGTH) : '';
}

/**
 * The throttle key of a lookup's order number: the number itself when it can be one ("0100001" and "100001" are one
 * key), else the typed text (malformed numbers still count, against a key no real order has).
 */
export function lookupThrottleKey(raw: unknown): string {
  const text = lookupNumberText(raw);
  const number = parseOrderNumber(text);
  return number === null ? `malformed:${text}` : String(number);
}

/**
 * "My order status" (spec §6.5, SHP-05): order number + the phone it was placed with → the order page link with the
 * order's own token. Guest and account orders alike: a token handover, nothing is linked to an account (decision 77).
 *
 * Leaks nothing: an unknown number, a wrong phone and malformed input all end in the same `lookupMiss()`. Every call
 * reads the order (number 0 when the number is malformed, which matches nothing) and compares a phone in constant
 * time, so an unknown number is not measurably faster than a wrong phone.
 */
@Injectable()
export class OrderLookupService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(rawNumber: unknown, rawPhone: unknown): Promise<string> {
    const number = parseOrderNumber(lookupNumberText(rawNumber));
    // The order's phone was stored as 05XXXXXXXX (checkout), the same form `normalizePhone` gives.
    const phone = normalizePhone(rawPhone);
    const order = await this.prisma.order.findUnique({
      where: { number: number ?? 0 },
      select: { number: true, publicToken: true, contact: true },
    });
    const stored = order ? phoneOf(order.contact) : null;
    const same = safeEqual(phone ?? NO_GIVEN_PHONE, stored ?? NO_ORDER_PHONE);
    if (!order || !same) throw lookupMiss();
    return confirmationPath(order.number, order.publicToken);
  }
}

function phoneOf(contact: unknown): string | null {
  const phone = (contact as { phone?: unknown } | null)?.phone;
  return typeof phone === 'string' ? phone : null;
}
