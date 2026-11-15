import { HttpException, HttpStatus } from '@nestjs/common';
import {
  CHECKOUT_LIMITS,
  RETURN_REASONS,
  SUPPORT_FIELD_MESSAGES_HE,
  SUPPORT_LIMITS,
  SUPPORT_NOT_DELIVERED_HE,
  SUPPORT_RETURN_WINDOW_PASSED_HE,
  type ReturnReason,
  type SupportErrorCode,
  type SupportField,
} from '@hg/models';
import { normalizeEmail, normalizePhone } from '../customers/contact-normalize.js';
import { parseOrderNumber } from '../orders/order-number.js';

/** Errors of the support endpoints: `{ statusCode, code, ...details }` (models `SupportErrorCode`). */
export class SupportError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: SupportErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: status, code, ...extra }, status);
  }
}

/** 400 naming the field; a line's field (`items.0.quantity`) carries the `items` message. */
export function supportField(field: SupportField | `items.${number}.${'orderItemId' | 'quantity'}`): SupportError {
  const key = (field.startsWith('items.') ? 'items' : field) as SupportField;
  return new SupportError(HttpStatus.BAD_REQUEST, 'invalid_field', {
    field,
    messageHe: SUPPORT_FIELD_MESSAGES_HE[key],
  });
}

export const notDelivered = () =>
  new SupportError(HttpStatus.CONFLICT, 'not_delivered', { messageHe: SUPPORT_NOT_DELIVERED_HE });
export const returnWindowPassed = () =>
  new SupportError(HttpStatus.CONFLICT, 'return_window_passed', { messageHe: SUPPORT_RETURN_WINDOW_PASSED_HE });

/** The order of a request as typed (number + phone); matched by the service, every miss is one 404. */
export interface OrderRefInput {
  number: string;
  phone: string;
}

export interface LineInput {
  orderItemId: number;
  quantity: number;
}

export interface ReturnInput {
  order: OrderRefInput | null;
  type: 'return' | 'exchange';
  items: LineInput[];
  reasonCode: ReturnReason;
  note: string | null;
}

export interface DamagedInput {
  order: OrderRefInput | null;
  orderItemId: number;
  description: string;
}

export interface ContactInput {
  fullName: string;
  phone: string;
  email: string;
  subject: string;
  message: string;
  orderNumber: number | null;
}

const MAX_QUANTITY = 1000;
const MAX_REF_TEXT = 32;

type Body = Record<string, unknown>;
const asBody = (raw: unknown): Body => (typeof raw === 'object' && raw !== null ? (raw as Body) : {});

/** The honeypot (spec §7.1): a hidden `website` field a person never fills. */
export function isHoneypot(raw: unknown): boolean {
  const website = asBody(raw).website;
  return typeof website === 'string' && website.trim() !== '';
}

/** A positive integer, as a JSON number or a digit string (multipart fields are strings). */
function positiveInt(value: unknown, max = 2_147_483_647): number | null {
  const n = typeof value === 'string' && /^\d{1,10}$/.test(value.trim()) ? Number(value.trim()) : value;
  return typeof n === 'number' && Number.isInteger(n) && n > 0 && n <= max ? n : null;
}

/** A trimmed text within [min, max], or null. */
function text(value: unknown, min: number, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length >= min && trimmed.length <= max ? trimmed : null;
}

/** The order reference: absent/null → null; an object → its number and phone as typed (cut to a sane length). */
function orderRef(value: unknown): OrderRefInput | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw supportField('order');
  const { number, phone } = value as Body;
  const asText = (v: unknown) =>
    typeof v === 'string' ? v.slice(0, MAX_REF_TEXT) : typeof v === 'number' ? String(v) : '';
  return { number: asText(number), phone: asText(phone) };
}

export function parseReturnInput(raw: unknown): ReturnInput {
  const body = asBody(raw);
  const order = orderRef(body.order);
  if (body.type !== 'return' && body.type !== 'exchange') throw supportField('type');
  const rawItems = body.items;
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > SUPPORT_LIMITS.itemsMax)
    throw supportField('items');
  const seen = new Set<number>();
  const items = rawItems.map((item, i): LineInput => {
    const line = asBody(item);
    const orderItemId = positiveInt(line.orderItemId);
    if (orderItemId === null || seen.has(orderItemId)) throw supportField(`items.${i}.orderItemId`);
    seen.add(orderItemId);
    const quantity = positiveInt(line.quantity, MAX_QUANTITY);
    if (quantity === null) throw supportField(`items.${i}.quantity`);
    return { orderItemId, quantity };
  });
  if (!RETURN_REASONS.includes(body.reasonCode as ReturnReason)) throw supportField('reasonCode');
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string') throw supportField('note');
    note = text(body.note, 0, SUPPORT_LIMITS.noteMax);
    if (note === null) throw supportField('note');
  }
  return { order, type: body.type, items, reasonCode: body.reasonCode as ReturnReason, note: note || null };
}

export function parseDamagedInput(raw: unknown): DamagedInput {
  const body = asBody(raw);
  const order = orderRef(body.order);
  const orderItemId = positiveInt(body.orderItemId);
  if (orderItemId === null) throw supportField('orderItemId');
  const description = text(body.description, SUPPORT_LIMITS.descriptionMin, SUPPORT_LIMITS.descriptionMax);
  if (description === null) throw supportField('description');
  return { order, orderItemId, description };
}

export function parseContactInput(raw: unknown): ContactInput {
  const body = asBody(raw);
  const fullName = text(body.fullName, CHECKOUT_LIMITS.fullNameMin, CHECKOUT_LIMITS.fullNameMax);
  if (fullName === null) throw supportField('fullName');
  const phone = normalizePhone(body.phone);
  if (phone === null) throw supportField('phone');
  const email = normalizeEmail(body.email);
  if (email === null) throw supportField('email');
  const subject = text(body.subject, SUPPORT_LIMITS.subjectMin, SUPPORT_LIMITS.subjectMax);
  if (subject === null) throw supportField('subject');
  const message = text(body.message, SUPPORT_LIMITS.messageMin, SUPPORT_LIMITS.messageMax);
  if (message === null) throw supportField('message');
  let orderNumber: number | null = null;
  if (body.orderNumber !== undefined && body.orderNumber !== null && body.orderNumber !== '') {
    const typed = typeof body.orderNumber === 'string' ? body.orderNumber.replace(/\s/g, '') : '';
    orderNumber = parseOrderNumber(typed.slice(0, MAX_REF_TEXT));
    if (orderNumber === null) throw supportField('orderNumber');
  }
  return { fullName, phone, email, subject, message, orderNumber };
}

/** SRV-02: a return or exchange is allowed while `now ≤ deliveredAt + returnWindowDays`. */
export function withinReturnWindow(deliveredAt: Date, returnWindowDays: number, now = new Date()): boolean {
  return now.getTime() <= returnUntil(deliveredAt, returnWindowDays).getTime();
}

/** The last moment a return or exchange can be requested (the order view's `returnUntil`). */
export function returnUntil(deliveredAt: Date, returnWindowDays: number): Date {
  return new Date(deliveredAt.getTime() + returnWindowDays * 24 * 60 * 60_000);
}

/** Used only if the settings row is missing (migration support inserts it with this value). */
export const DEFAULT_RETURN_WINDOW_DAYS = 14;

/** Every requested line is a line of the order, for at most its ordered quantity (400 naming the line otherwise). */
export function matchLines(requested: LineInput[], orderLines: { id: number; quantity: number }[]): void {
  const byId = new Map(orderLines.map((l) => [l.id, l.quantity]));
  requested.forEach((line, i) => {
    const ordered = byId.get(line.orderItemId);
    if (ordered === undefined) throw supportField(`items.${i}.orderItemId`);
    if (line.quantity > ordered) throw supportField(`items.${i}.quantity`);
  });
}
