import { HttpException } from '@nestjs/common';
import type { CheckoutRequest } from '@hg/models';
import { parseCheckoutRequest } from './checkout.service.js';

const valid = (): CheckoutRequest => ({
  contact: { fullName: 'דנה כהן', phone: '050-123 4567', email: 'dana@example.test' },
  address: {
    localityId: 5000,
    street: 'הרצל',
    houseNumber: '12א',
    apartment: '4',
    floor: 3,
    hasElevator: false,
    notes: 'להתקשר לפני',
  },
  method: 'full_service',
  acceptTerms: true,
});

/** The 400 body for a request with one field changed (`undefined` removes it). */
function errorFor(path: string, value: unknown): unknown {
  const body = valid() as unknown as Record<string, unknown>;
  const [head, tail] = path.split('.');
  const target = (tail ? body[head] : body) as Record<string, unknown>;
  const key = tail ?? head;
  if (value === undefined) delete target[key];
  else target[key] = value;
  try {
    parseCheckoutRequest(body);
  } catch (e) {
    expect(e).toBeInstanceOf(HttpException);
    expect((e as HttpException).getStatus()).toBe(400);
    return (e as HttpException).getResponse();
  }
  throw new Error(`expected ${path} = ${JSON.stringify(value)} to be refused`);
}

const MESSAGES = {
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

describe('parseCheckoutRequest (spec §5.1, §5.2)', () => {
  it('accepts a valid request, trimming text and normalizing the phone', () => {
    const body = valid();
    body.contact.fullName = '  דנה כהן ';
    body.contact.email = ' Dana@Example.test ';
    body.address.street = ' הרצל ';
    expect(parseCheckoutRequest(body)).toEqual({
      contact: { fullName: 'דנה כהן', phone: '0501234567', email: 'Dana@Example.test' },
      address: {
        localityId: 5000,
        street: 'הרצל',
        houseNumber: '12א',
        apartment: '4',
        floor: 3,
        hasElevator: false,
        notes: 'להתקשר לפני',
      },
      method: 'full_service',
      acceptTerms: true,
    });
  });

  it('turns empty or missing optional fields into null', () => {
    const body = valid() as unknown as { address: Record<string, unknown> };
    body.address.apartment = '  ';
    delete body.address.notes;
    const parsed = parseCheckoutRequest(body);
    expect(parsed.address.apartment).toBeNull();
    expect(parsed.address.notes).toBeNull();
  });

  const cases: [keyof typeof MESSAGES, unknown[]][] = [
    ['contact.fullName', [undefined, '', ' א ', 'א'.repeat(81), 12]],
    [
      'contact.phone',
      [undefined, '', '0412345678', '05012345', '050123456789', '+972501234567', '05x1234567', 501234567],
    ],
    [
      'contact.email',
      [
        undefined,
        '',
        'dana',
        'dana@',
        '@example.test',
        'dana@example',
        'da na@example.test',
        `${'a'.repeat(250)}@x.co`,
      ],
    ],
    ['address.localityId', [undefined, 0, -1, 1.5, '5000', null]],
    ['address.street', [undefined, '', '   ', 'א'.repeat(81)]],
    ['address.houseNumber', [undefined, '', '12345678901', 12]],
    ['address.apartment', ['12345678901', 4]],
    ['address.floor', [undefined, -1, 61, 2.5, '3', null]],
    ['address.hasElevator', [undefined, 'yes', 1, null]],
    ['address.notes', ['א'.repeat(501), 7]],
    ['method', [undefined, '', 'pickup', 'CURBSIDE']],
    ['acceptTerms', [undefined, false, 'true', 1]],
  ];

  it.each(cases)('refuses %s with its field and Hebrew message', (field, values) => {
    for (const value of values)
      expect(errorFor(field, value)).toEqual({
        statusCode: 400,
        code: 'invalid_field',
        field,
        messageHe: MESSAGES[field],
      });
  });

  it('accepts the boundaries', () => {
    const body = valid();
    body.contact.fullName = 'אב';
    body.address.floor = 0;
    body.address.houseNumber = '1';
    body.address.street = 'א'.repeat(80);
    expect(() => parseCheckoutRequest(body)).not.toThrow();
    body.contact.fullName = 'א'.repeat(80);
    body.address.floor = 60;
    body.address.houseNumber = '1234567890';
    body.method = 'curbside';
    expect(() => parseCheckoutRequest(body)).not.toThrow();
  });

  it('refuses a body that is not an object, naming the first section', () => {
    for (const body of [null, undefined, 'x', []]) {
      try {
        parseCheckoutRequest(body);
        throw new Error('not refused');
      } catch (e) {
        expect((e as HttpException).getResponse()).toMatchObject({ code: 'invalid_field', field: 'contact.fullName' });
      }
    }
  });
});
