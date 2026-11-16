import { randomInt } from 'node:crypto';
import type { CouponProblem } from '@hg/models';
import { PromotionKind as DbPromotionKind, type Prisma } from '../generated/prisma/client.js';
import type { PromotionRule } from './discount-engine.js';

/**
 * Personal codes (decisions 93–94, spec §5.2): one account's single-use code issued from a `personal_template`
 * promotion. A code is evaluated as a coupon with the template's terms as they are when it is used (value, minimum,
 * target, dates, switches); a deactivated template voids its unused codes. Codes are secrets of a sort: never put one
 * in an audit entry or a log line.
 */

/** Upper-case letters and digits without the look-alikes I, L, O, 0 and 1. */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_PREFIX = 'NST-';
const CODE_LENGTH = 8;
/** Attempts at a code that is free (31^8 ≈ 8.5 × 10^11 codes: a clash is already rare). */
const MAX_ATTEMPTS = 10;
const DAY_MS = 24 * 60 * 60_000;

/** "NST-" + 8 characters of `CODE_ALPHABET` (uniform: `randomInt` has no modulo bias). Already normalized. */
export function generateCode(): string {
  let code = CODE_PREFIX;
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code;
}

/** Issue time + `validityDays`, never after the template's `endsAt`. */
export function codeExpiry(now: Date, validityDays: number, endsAt: Date | null): Date {
  const expiry = new Date(now.getTime() + validityDays * DAY_MS);
  return endsAt && endsAt < expiry ? new Date(endsAt) : expiry;
}

export interface IssueInput {
  templateId: number;
  customerId: string;
  /** The staff member who issues it; null = the welcome code of a new account. */
  issuedById: number | null;
  now: Date;
}

/**
 * Issues a personal code from an active template, in the caller's transaction. The code is never equal to another
 * personal code or a coupon code: a drawn code that is taken is drawn again. (Two concurrent issues drawing the same
 * free code — about one in 10^11 — make the second insert fail on the unique index, and its transaction with it.)
 * Throws when the template is not an active `personal_template`.
 */
export async function issuePersonalCode(
  tx: Prisma.TransactionClient,
  { templateId, customerId, issuedById, now }: IssueInput,
  generate: () => string = generateCode,
): Promise<{ code: string; expiresAt: Date }> {
  const template = await tx.promotion.findUnique({ where: { id: templateId } });
  if (!template || template.kind !== DbPromotionKind.PERSONAL_TEMPLATE || !template.active || !template.validityDays)
    throw new Error(`Promotion ${templateId} is not an active personal-code template`);
  const expiresAt = codeExpiry(now, template.validityDays, template.endsAt);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const code = generate();
    if (await tx.personalCode.findUnique({ where: { code }, select: { id: true } })) continue;
    if (await tx.promotion.findUnique({ where: { code }, select: { id: true } })) continue;
    await tx.personalCode.create({
      data: { code, promotionId: templateId, customerId, issuedById, expiresAt, createdAt: now },
    });
    return { code, expiresAt };
  }
  throw new Error('Could not find a free personal code');
}

/** A personal code with what its evaluation needs (read by `PromotionsService`). */
export interface PersonalCodeState {
  id: number;
  code: string;
  customerId: string;
  expiresAt: Date;
  /** The paid order that used it; null while unused. */
  orderId: string | null;
  /** Another live pending order (not excluded) holds it. */
  held: boolean;
  /** The template as it is now. */
  template: PromotionRule;
}

/** Who enters the code: the cart's account (null for a guest), whether the cart is a member's, and its paid orders. */
export interface PersonalCodeBuyer {
  customerId: string | null;
  isMember: boolean;
  hasPaidOrder: boolean;
}

/**
 * Why this personal code cannot be used by this buyer now, before the engine's own checks (dates, minimum, target),
 * or null. In this order: a guest → `members_only` (decision 90); another account's code, the guest hint (a member's
 * pricing with no account), or a template that is off or no template → `unknown` (the same wording, so codes cannot
 * be probed); used by a paid order or held by another live pending order → `exhausted`; past its expiry → `expired`;
 * a welcome code once the account has a paid order → `first_order_only`.
 */
export function personalCodeProblem(
  code: PersonalCodeState,
  buyer: PersonalCodeBuyer,
  now: Date,
): CouponProblem | null {
  if (!buyer.isMember) return 'members_only';
  if (buyer.customerId === null || code.customerId !== buyer.customerId) return 'unknown';
  if (code.template.kind !== 'personal_template' || !code.template.active) return 'unknown';
  if (code.orderId !== null || code.held) return 'exhausted';
  if (now > code.expiresAt) return 'expired';
  if (code.template.isWelcome === true && buyer.hasPaidOrder) return 'first_order_only';
  return null;
}

/**
 * The coupon the engine evaluates for a usable personal code: the template's current terms, the code, single use (no
 * usage limit of its own), members only, and an end at the code's expiry when that comes first. Its `id` is the
 * template's (the order's `promotionId`), `personalCodeId` the code's (the order's `personalCodeId`).
 */
export function personalCodeRule(code: PersonalCodeState): PromotionRule {
  const { template } = code;
  const endsAt = template.endsAt && template.endsAt < code.expiresAt ? template.endsAt : code.expiresAt;
  return {
    ...template,
    kind: 'coupon',
    code: code.code,
    usageLimit: null,
    usedCount: 0,
    membersOnly: true,
    usedByAccount: undefined,
    endsAt,
    personalCodeId: code.id,
  };
}
