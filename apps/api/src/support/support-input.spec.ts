import { RETURN_REASONS, RETURN_REASON_LABELS_HE, SUPPORT_FIELD_MESSAGES_HE } from '@hg/models';
import {
  isHoneypot,
  matchLines,
  parseContactInput,
  parseDamagedInput,
  parseReturnInput,
  SupportError,
  returnUntil,
  withinReturnWindow,
} from './support-input.js';

/** The 400 `{ field }` a parse throws, or null when it does not throw. */
function fieldOf(run: () => unknown): string | null {
  try {
    run();
    return null;
  } catch (error) {
    if (!(error instanceof SupportError)) throw error;
    const body = error.getResponse() as { code: string; field: string; messageHe: string };
    expect(error.getStatus()).toBe(400);
    expect(body.code).toBe('invalid_field');
    expect(body.messageHe).toBeTruthy();
    return body.field;
  }
}

describe('return reasons (spec §7.1)', () => {
  it('is the closed list with its Hebrew labels', () => {
    expect(RETURN_REASONS).toEqual(['changed_mind', 'not_as_described', 'wrong_item', 'size', 'other']);
    expect(RETURN_REASON_LABELS_HE).toEqual({
      changed_mind: 'התחרטתי',
      not_as_described: 'לא תואם לתיאור',
      wrong_item: 'התקבל פריט שגוי',
      size: 'המידה לא מתאימה',
      other: 'אחר',
    });
  });
});

describe('parseReturnInput', () => {
  const valid = {
    order: { number: ' 100001', phone: '050-1234567' },
    type: 'return',
    items: [{ orderItemId: 7, quantity: 2 }],
    reasonCode: 'size',
    note: '  ארוך מדי  ',
  };

  it('accepts a valid request, trims the note and keeps the order reference as typed', () => {
    expect(parseReturnInput(valid)).toEqual({
      order: { number: ' 100001', phone: '050-1234567' },
      type: 'return',
      items: [{ orderItemId: 7, quantity: 2 }],
      reasonCode: 'size',
      note: 'ארוך מדי',
    });
  });

  it('accepts exchange, a null order, digit strings for numbers and no note', () => {
    expect(
      parseReturnInput({
        ...valid,
        order: null,
        type: 'exchange',
        items: [{ orderItemId: '7', quantity: '1' }],
        note: '',
      }),
    ).toEqual({
      order: null,
      type: 'exchange',
      items: [{ orderItemId: 7, quantity: 1 }],
      reasonCode: 'size',
      note: null,
    });
  });

  it.each([
    [{ type: 'refund' }, 'type'],
    [{ reasonCode: 'bored' }, 'reasonCode'],
    [{ reasonCode: undefined }, 'reasonCode'],
    [{ items: [] }, 'items'],
    [{ items: 'x' }, 'items'],
    [{ items: [{ orderItemId: 0, quantity: 1 }] }, 'items.0.orderItemId'],
    [
      {
        items: [
          { orderItemId: 7, quantity: 1 },
          { orderItemId: 7, quantity: 1 },
        ],
      },
      'items.1.orderItemId',
    ],
    [{ items: [{ orderItemId: 7, quantity: 0 }] }, 'items.0.quantity'],
    [{ items: [{ orderItemId: 7, quantity: 1.5 }] }, 'items.0.quantity'],
    [{ note: 'א'.repeat(1001) }, 'note'],
    [{ note: 5 }, 'note'],
    [{ order: 'x' }, 'order'],
  ])('%o → 400 %s', (patch, field) => {
    expect(fieldOf(() => parseReturnInput({ ...valid, ...patch }))).toBe(field);
  });

  it('every message comes from the shared list', () => {
    expect(SUPPORT_FIELD_MESSAGES_HE.items).toBeTruthy();
    expect(SUPPORT_FIELD_MESSAGES_HE.reasonCode).toBeTruthy();
  });
});

describe('parseDamagedInput', () => {
  const valid = {
    order: { number: '100001', phone: '0501234567' },
    orderItemId: '7',
    description: 'הרגל נשברה בהובלה',
  };

  it('accepts multipart strings', () => {
    expect(parseDamagedInput(valid)).toEqual({
      order: { number: '100001', phone: '0501234567' },
      orderItemId: 7,
      description: 'הרגל נשברה בהובלה',
    });
  });

  it.each([
    [{ orderItemId: 'x' }, 'orderItemId'],
    [{ description: 'קצר' }, 'description'],
    [{ description: 'א'.repeat(2001) }, 'description'],
    [{ description: undefined }, 'description'],
  ])('%o → 400 %s', (patch, field) => {
    expect(fieldOf(() => parseDamagedInput({ ...valid, ...patch }))).toBe(field);
  });

  it('description length counts after trimming: 10 is enough', () => {
    expect(parseDamagedInput({ ...valid, description: `  ${'א'.repeat(10)}  ` }).description).toBe('א'.repeat(10));
  });
});

describe('parseContactInput', () => {
  const valid = {
    fullName: ' דנה כהן ',
    phone: '+972-50-1234567',
    email: ' Dana@Example.TEST ',
    subject: 'שאלה על ספה',
    message: 'האם יש את הספה בצבע אפור?',
  };

  it('normalizes phone and e-mail like checkout, with no order number', () => {
    expect(parseContactInput(valid)).toEqual({
      fullName: 'דנה כהן',
      phone: '0501234567',
      email: 'dana@example.test',
      subject: 'שאלה על ספה',
      message: 'האם יש את הספה בצבע אפור?',
      orderNumber: null,
    });
  });

  it('an order number is parsed (spaces removed); an empty one is none', () => {
    expect(parseContactInput({ ...valid, orderNumber: ' 100001 ' }).orderNumber).toBe(100001);
    expect(parseContactInput({ ...valid, orderNumber: '' }).orderNumber).toBeNull();
  });

  it.each([
    [{ fullName: 'א' }, 'fullName'],
    [{ phone: '03-1234567' }, 'phone'],
    [{ email: 'dana@' }, 'email'],
    [{ subject: 'א' }, 'subject'],
    [{ subject: 'א'.repeat(121) }, 'subject'],
    [{ message: 'קצר' }, 'message'],
    [{ message: 'א'.repeat(2001) }, 'message'],
    [{ orderNumber: '12' }, 'orderNumber'],
    [{ orderNumber: '99999999999' }, 'orderNumber'],
  ])('%o → 400 %s', (patch, field) => {
    expect(fieldOf(() => parseContactInput({ ...valid, ...patch }))).toBe(field);
  });
});

describe('isHoneypot', () => {
  it('only a non-empty website field', () => {
    expect(isHoneypot({ website: 'http://spam.test' })).toBe(true);
    expect(isHoneypot({ website: ' x ' })).toBe(true);
    expect(isHoneypot({ website: '' })).toBe(false);
    expect(isHoneypot({})).toBe(false);
    expect(isHoneypot(null)).toBe(false);
  });
});

describe('withinReturnWindow (SRV-02): until the end of the Israel calendar day', () => {
  // 12:00 in Israel (UTC+2) on 1.11 → the last allowed instant is 15.11 23:59:59.999 Israel time.
  const deliveredAt = new Date('2026-11-01T10:00:00.000Z');
  const last = new Date('2026-11-15T21:59:59.999Z');

  it('allowed from delivery up to 23:59:59.999 Israel time of the shown last date', () => {
    expect(withinReturnWindow(deliveredAt, 14, deliveredAt)).toBe(true);
    // The delivery hour on the last day no longer matters (it did with N×24 h).
    expect(withinReturnWindow(deliveredAt, 14, new Date('2026-11-15T18:00:00.000Z'))).toBe(true);
    expect(withinReturnWindow(deliveredAt, 14, last)).toBe(true);
  });

  it('refused one millisecond later', () => {
    expect(withinReturnWindow(deliveredAt, 14, new Date(last.getTime() + 1))).toBe(false);
  });

  it('a window of 0 days allows the rest of the delivery day in Israel', () => {
    expect(withinReturnWindow(deliveredAt, 0, new Date('2026-11-01T21:59:59.999Z'))).toBe(true);
    expect(withinReturnWindow(deliveredAt, 0, new Date('2026-11-01T22:00:00.000Z'))).toBe(false);
  });
});

describe('matchLines', () => {
  const lines = [
    { id: 7, quantity: 2 },
    { id: 8, quantity: 1 },
  ];

  it('accepts lines of the order up to their quantity', () => {
    expect(() =>
      matchLines(
        [
          { orderItemId: 7, quantity: 2 },
          { orderItemId: 8, quantity: 1 },
        ],
        lines,
      ),
    ).not.toThrow();
  });

  it('a line of another order → items.<i>.orderItemId; more than ordered → items.<i>.quantity', () => {
    expect(fieldOf(() => matchLines([{ orderItemId: 9, quantity: 1 }], lines))).toBe('items.0.orderItemId');
    expect(
      fieldOf(() =>
        matchLines(
          [
            { orderItemId: 8, quantity: 1 },
            { orderItemId: 7, quantity: 3 },
          ],
          lines,
        ),
      ),
    ).toBe('items.1.quantity');
  });
});

describe('returnUntil (the order view deadline)', () => {
  const at = (iso: string, days = 14) => returnUntil(new Date(iso), days).toISOString();

  it('is the end of the Israel day of delivery + the window, the same boundary withinReturnWindow allows', () => {
    const deliveredAt = new Date('2026-11-01T10:00:00.000Z');
    const until = returnUntil(deliveredAt, 14);
    expect(until.toISOString()).toBe('2026-11-15T21:59:59.999Z');
    expect(withinReturnWindow(deliveredAt, 14, until)).toBe(true);
    expect(withinReturnWindow(deliveredAt, 14, new Date(until.getTime() + 1))).toBe(false);
  });

  it('counts from the Israel date, not the UTC date', () => {
    // 22:30 UTC on 1.11 is already 00:30 on 2.11 in Israel → until 16.11.
    expect(at('2026-11-01T22:30:00.000Z')).toBe('2026-11-16T21:59:59.999Z');
    // 21:30 UTC on 1.11 is 23:30 on 1.11 in Israel → until 15.11.
    expect(at('2026-11-01T21:30:00.000Z')).toBe('2026-11-15T21:59:59.999Z');
    // Summer (UTC+3): 21:30 UTC on 1.7 is 00:30 on 2.7 in Israel → until 16.7, 23:59:59.999 IDT.
    expect(at('2026-07-01T21:30:00.000Z')).toBe('2026-07-16T20:59:59.999Z');
    // Summer: 20:30 UTC on 1.7 is 23:30 on 1.7 in Israel → until 15.7.
    expect(at('2026-07-01T20:30:00.000Z')).toBe('2026-07-15T20:59:59.999Z');
  });

  it('uses the offset of the last day across a DST change', () => {
    // Delivered in summer time (+3), the last day is after the change back (25.10.2026) → +2.
    expect(at('2026-10-15T09:00:00.000Z')).toBe('2026-10-29T21:59:59.999Z');
    // Delivered in winter time (+2), the last day is after the change to summer time (27.3.2026) → +3.
    expect(at('2026-03-20T09:00:00.000Z')).toBe('2026-04-03T20:59:59.999Z');
  });

  it('a window of 0 days ends with the delivery day itself', () => {
    expect(at('2026-11-01T10:00:00.000Z', 0)).toBe('2026-11-01T21:59:59.999Z');
  });
});
