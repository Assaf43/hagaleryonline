import { creditNoteLines, orderInvoiceLines } from './invoice-lines.js';

const ORDER = {
  number: 100123,
  total: 105_000,
  discount: 10_000,
  discountInfo: { labelHe: 'קופון WINTER', source: 'coupon' },
  shippingLines: [
    { labelHe: 'הובלה', amount: 10_000 },
    { labelHe: 'הכנסה לבית', amount: 5_000 },
  ],
  items: [
    {
      modelName: 'ALBA',
      nameHe: 'ספה',
      optionLabels: ['בז׳', 'פינה ימנית'],
      unitPrice: 40_000,
      quantity: 2,
      lineTotal: 80_000,
    },
    { modelName: 'NOVA', nameHe: 'כורסה', optionLabels: [], unitPrice: 20_000, quantity: 1, lineTotal: 20_000 },
  ],
};

describe('orderInvoiceLines', () => {
  it('lists the items, the shipping lines and a negative discount line that add up to the total', () => {
    expect(orderInvoiceLines(ORDER)).toEqual([
      { description: 'ALBA ספה בז׳, פינה ימנית', quantity: 2, unitPrice: 40_000, lineTotal: 80_000 },
      { description: 'NOVA כורסה', quantity: 1, unitPrice: 20_000, lineTotal: 20_000 },
      { description: 'הובלה', quantity: 1, unitPrice: 10_000, lineTotal: 10_000 },
      { description: 'הכנסה לבית', quantity: 1, unitPrice: 5_000, lineTotal: 5_000 },
      { description: 'קופון WINTER', quantity: 1, unitPrice: -10_000, lineTotal: -10_000 },
    ]);
  });

  it('has no discount line without a discount, and names a discount without a label "הנחה"', () => {
    const plain = orderInvoiceLines({ ...ORDER, discount: 0, discountInfo: null, total: 115_000 });
    expect(plain.map((l) => l.description)).not.toContain('קופון WINTER');
    expect(plain).toHaveLength(4);
    const unnamed = orderInvoiceLines({ ...ORDER, discountInfo: null });
    expect(unnamed.at(-1)).toMatchObject({ description: 'הנחה', lineTotal: -10_000 });
  });

  it('skips zero shipping lines', () => {
    const lines = orderInvoiceLines({
      ...ORDER,
      shippingLines: [...ORDER.shippingLines, { labelHe: 'קומה', amount: 0 }],
    });
    expect(lines.map((l) => l.description)).not.toContain('קומה');
  });

  it('throws when the lines do not add up to the order total (no tax document is issued)', () => {
    expect(() => orderInvoiceLines({ ...ORDER, total: 105_001 })).toThrow(/do not add up/);
    expect(() => orderInvoiceLines({ ...ORDER, shippingLines: 'bad' })).toThrow(/shipping lines/);
  });
});

describe('creditNoteLines', () => {
  it('is one line "זיכוי להזמנה {number}" for the refund amount', () => {
    expect(creditNoteLines(100123, 25_000)).toEqual([
      { description: 'זיכוי להזמנה 100123', quantity: 1, unitPrice: 25_000, lineTotal: 25_000 },
    ]);
  });
});
