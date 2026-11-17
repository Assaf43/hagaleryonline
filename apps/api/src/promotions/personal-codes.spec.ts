import { normalizeCouponCode } from '@hg/models';
import { PromotionKind, type Prisma } from '../generated/prisma/client.js';
import { couponProblem, evaluateDiscount, type PromotionRule } from './discount-engine.js';
import {
  CODE_ALPHABET,
  codeExpiry,
  generateCode,
  issuePersonalCode,
  looksLikePersonalCode,
  personalCodeProblem,
  personalCodeRule,
  type PersonalCodeBuyer,
  type PersonalCodeState,
} from './personal-codes.js';

const NOW = new Date('2026-11-16T12:00:00Z');
const DAY = 24 * 60 * 60_000;
const OWNER = '00000000-0000-4000-8000-000000000001';

function template(patch: Partial<PromotionRule> = {}): PromotionRule {
  return {
    id: 7,
    name: 'הטבת הצטרפות',
    kind: 'personal_template',
    code: null,
    discountType: 'percent',
    value: 10,
    target: 'order',
    targetIds: [],
    minSubtotal: 0,
    startsAt: null,
    endsAt: null,
    usageLimit: null,
    usedCount: 0,
    active: true,
    isWelcome: false,
    membersOnly: false,
    appliesToMemberPrices: false,
    ...patch,
  };
}

function state(patch: Partial<PersonalCodeState> = {}, rule: Partial<PromotionRule> = {}): PersonalCodeState {
  return {
    id: 3,
    code: 'NST-ABCD2345',
    customerId: OWNER,
    expiresAt: new Date(NOW.getTime() + 10 * DAY),
    orderId: null,
    held: false,
    template: template(rule),
    ...patch,
  };
}

const owner: PersonalCodeBuyer = { customerId: OWNER, isMember: true, hasPaidOrder: false };
const line = { productId: 1, categoryPathIds: [1], lineTotal: 100_000, atMemberPrice: false };

describe('generateCode', () => {
  it('is "NST-" + 8 characters of the unambiguous alphabet, already in its normalized form', () => {
    expect(CODE_ALPHABET).toBe('ABCDEFGHJKMNPQRSTUVWXYZ23456789');
    for (const ch of 'ILO01') expect(CODE_ALPHABET).not.toContain(ch);
    for (let i = 0; i < 200; i++) {
      const code = generateCode();
      expect(code).toMatch(/^NST-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
      expect(normalizeCouponCode(code)).toBe(code);
    }
  });

  it('uses every character of the alphabet (no modulo gap)', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of generateCode().slice(4)) seen.add(ch);
    expect(seen.size).toBe(CODE_ALPHABET.length);
  });
});

describe('looksLikePersonalCode', () => {
  it('is "NST-" + 8 characters of the code alphabet, nothing else', () => {
    expect(looksLikePersonalCode(generateCode())).toBe(true);
    expect(looksLikePersonalCode('NST-ZZZZZZZZ')).toBe(true);
    for (const other of ['NST-ZZZZZZZ', 'NST-ZZZZZZZZZ', 'NST-ZZZZZZZ0', 'NST-ZZZZZZZI', 'SALE10', 'nst-zzzzzzzz'])
      expect(looksLikePersonalCode(other)).toBe(false);
  });
});

describe('codeExpiry', () => {
  it('is the issue time + validity days', () => {
    expect(codeExpiry(NOW, 30, null)).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  it("never after the template's end date", () => {
    const endsAt = new Date(NOW.getTime() + 5 * DAY);
    expect(codeExpiry(NOW, 30, endsAt)).toEqual(endsAt);
    expect(codeExpiry(NOW, 3, endsAt)).toEqual(new Date(NOW.getTime() + 3 * DAY));
  });
});

describe('issuePersonalCode', () => {
  const fakeTx = (template: Record<string, unknown> | null) => {
    const created: Record<string, unknown>[] = [];
    const tx = {
      promotion: {
        findUnique: ({ where }: { where: { id?: number; code?: string } }) =>
          Promise.resolve(where.id !== undefined ? template : where.code === 'NST-COUPON22' ? { id: 1 } : null),
      },
      personalCode: {
        findUnique: ({ where }: { where: { code: string } }) =>
          Promise.resolve(where.code === 'NST-TAKEN222' ? { id: 1 } : null),
        create: ({ data }: { data: Record<string, unknown> }) => Promise.resolve({ id: 40 + created.push(data) }),
      },
    };
    return { tx: tx as unknown as Prisma.TransactionClient, created };
  };
  const active = { id: 7, kind: PromotionKind.PERSONAL_TEMPLATE, active: true, validityDays: 30, endsAt: null };

  it('draws again while the code is taken by another personal code or a coupon', async () => {
    const draws = ['NST-TAKEN222', 'NST-COUPON22', 'NST-FREE2345'];
    const { tx, created } = fakeTx(active);
    const issued = await issuePersonalCode(tx, { templateId: 7, customerId: OWNER, issuedById: 4, now: NOW }, () =>
      draws.shift()!,
    );
    expect(issued).toEqual({ id: 41, code: 'NST-FREE2345', expiresAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(created).toEqual([
      {
        code: 'NST-FREE2345',
        promotionId: 7,
        customerId: OWNER,
        issuedById: 4,
        expiresAt: new Date(NOW.getTime() + 30 * DAY),
        createdAt: NOW,
      },
    ]);
  });

  it('expiry capped by the template end date', async () => {
    const endsAt = new Date(NOW.getTime() + DAY);
    const { tx } = fakeTx({ ...active, endsAt });
    expect(
      (await issuePersonalCode(tx, { templateId: 7, customerId: OWNER, issuedById: null, now: NOW })).expiresAt,
    ).toEqual(endsAt);
  });

  it('only from an active personal-code template', async () => {
    const input = { templateId: 7, customerId: OWNER, issuedById: null, now: NOW };
    await expect(issuePersonalCode(fakeTx(null).tx, input)).rejects.toThrow();
    await expect(issuePersonalCode(fakeTx({ ...active, active: false }).tx, input)).rejects.toThrow();
    await expect(
      issuePersonalCode(fakeTx({ ...active, kind: PromotionKind.COUPON, validityDays: null }).tx, input),
    ).rejects.toThrow();
  });
});

describe('personalCodeProblem', () => {
  it('the owner, unused, unexpired, active template: valid', () => {
    expect(personalCodeProblem(state(), owner, NOW)).toBeNull();
  });

  it('a guest → members_only (decision 90)', () => {
    expect(personalCodeProblem(state(), { customerId: null, isMember: false, hasPaidOrder: false }, NOW)).toBe(
      'members_only',
    );
    // A store cart whose customer is not (or no longer) confirmed is no member's cart either.
    expect(personalCodeProblem(state(), { ...owner, isMember: false }, NOW)).toBe('members_only');
  });

  it("another account's code answers like an unknown code", () => {
    const other = { ...owner, customerId: '00000000-0000-4000-8000-000000000002' };
    expect(personalCodeProblem(state(), other, NOW)).toBe('unknown');
    // The guest hint (a member's pricing without an account) never uses a personal code.
    expect(personalCodeProblem(state(), { customerId: null, isMember: true, hasPaidOrder: false }, NOW)).toBe(
      'unknown',
    );
  });

  it('a deactivated template voids its codes: unknown', () => {
    expect(personalCodeProblem(state({}, { active: false }), owner, NOW)).toBe('unknown');
  });

  it('a row that is no template (any more) is unknown', () => {
    expect(personalCodeProblem(state({}, { kind: 'automatic' }), owner, NOW)).toBe('unknown');
  });

  it('used by a paid order → exhausted; held by another live pending order → exhausted', () => {
    expect(personalCodeProblem(state({ orderId: 'paid-order' }), owner, NOW)).toBe('exhausted');
    expect(personalCodeProblem(state({ held: true }), owner, NOW)).toBe('exhausted');
  });

  it('past its expiry → expired', () => {
    expect(personalCodeProblem(state({ expiresAt: new Date(NOW.getTime() - 1) }), owner, NOW)).toBe('expired');
    expect(personalCodeProblem(state({ expiresAt: NOW }), owner, NOW)).toBeNull();
  });

  it('a welcome code once the account has a paid order → first_order_only; any other code still works', () => {
    const paid = { ...owner, hasPaidOrder: true };
    expect(personalCodeProblem(state({}, { isWelcome: true }), paid, NOW)).toBe('first_order_only');
    expect(personalCodeProblem(state({}, { isWelcome: true }), owner, NOW)).toBeNull();
    expect(personalCodeProblem(state(), paid, NOW)).toBeNull();
  });
});

describe('personalCodeRule', () => {
  it("a single-use coupon with the template's current terms, the code and an end at the code's expiry", () => {
    const rule = personalCodeRule(state({}, { value: 15, minSubtotal: 50_000, endsAt: new Date(NOW.getTime() + DAY) }));
    expect(rule).toMatchObject({
      id: 7,
      kind: 'coupon',
      code: 'NST-ABCD2345',
      value: 15,
      minSubtotal: 50_000,
      usageLimit: null,
      membersOnly: true,
      personalCodeId: 3,
      endsAt: new Date(NOW.getTime() + DAY),
    });
    expect(personalCodeRule(state()).endsAt).toEqual(new Date(NOW.getTime() + 10 * DAY));
  });

  it('the engine applies it as the entered coupon, and still checks the dates and the minimum', () => {
    const rule = personalCodeRule(state());
    expect(evaluateDiscount([line], [], rule, NOW, { isMember: true }).applied).toEqual({
      labelHe: 'הטבת הצטרפות',
      amount: 10_000,
      source: 'coupon',
      code: 'NST-ABCD2345',
    });
    const later = personalCodeRule(state({}, { startsAt: new Date(NOW.getTime() + DAY) }));
    expect(couponProblem(later, 100_000, NOW, { isMember: true })).toBe('not_started');
    const big = personalCodeRule(state({}, { minSubtotal: 200_000 }));
    expect(couponProblem(big, 100_000, NOW, { isMember: true })).toBe('below_minimum');
    // Never for a guest, whatever the caller passes.
    expect(couponProblem(rule, 100_000, NOW, { isMember: false })).toBe('members_only');
  });
});
