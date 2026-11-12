import type { ConfigService } from '@nestjs/config';
import { MockInvoiceProvider, renderMockDocument } from './mock-invoice.provider.js';

const config = (env: Record<string, string>) => ({ get: (key: string) => env[key] }) as unknown as ConfigService;

describe('MockInvoiceProvider', () => {
  it('refuses to load in production', () => {
    expect(() => new MockInvoiceProvider(config({ NODE_ENV: 'production' }), {} as never)).toThrow(/production/);
    expect(new MockInvoiceProvider(config({ NODE_ENV: 'development' }), {} as never).code).toBe('mock');
  });
});

describe('renderMockDocument', () => {
  const base = {
    type: 'tax_invoice_receipt' as const,
    number: 'MOCK-INV-000042',
    issuedAt: new Date('2026-11-12T22:30:00Z'),
    orderNumber: 100123,
    customer: { fullName: 'דנה <script>', email: 'd@example.test', phone: '0501234567' },
    lines: [
      { description: 'ALBA ספה', quantity: 2, unitPrice: 59_000, lineTotal: 118_000 },
      { description: 'הנחה', quantity: 1, unitPrice: -10_000, lineTotal: -10_000 },
    ],
    amount: 108_000,
    vatAmount: 16_475,
    vatRate: 0.18,
  };

  it('is a self-contained Hebrew RTL page with seller, escaped buyer, Israel date, lines, VAT and total', () => {
    const html = renderMockDocument(base);
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<html lang="he" dir="rtl">');
    expect(html).toContain('NESTO');
    expect(html).toContain('חשבונית מס/קבלה');
    expect(html).toContain('MOCK-INV-000042');
    expect(html).toContain('100123');
    expect(html).toContain('דנה &lt;script&gt;');
    expect(html).not.toContain('<script>');
    // 22:30 UTC on 12.11 is already 13.11 in Israel.
    expect(html).toContain('13.11.2026');
    expect(html).toContain('ALBA ספה');
    expect(html).toContain('1,180.00 ₪');
    expect(html).toContain('-100.00 ₪');
    // Before VAT = total − VAT; VAT rate and amount; total.
    expect(html).toContain('915.25 ₪');
    expect(html).toContain('18%');
    expect(html).toContain('164.75 ₪');
    expect(html).toContain('1,080.00 ₪');
    expect(html).not.toMatch(/<link|<script|src=/);
  });

  it('a credit note says "חשבונית זיכוי" and shows its amount', () => {
    const html = renderMockDocument({
      ...base,
      type: 'credit_note',
      number: 'MOCK-CN-000007',
      lines: [{ description: 'זיכוי להזמנה 100123', quantity: 1, unitPrice: 20_000, lineTotal: 20_000 }],
      amount: 20_000,
      vatAmount: 3_051,
    });
    expect(html).toContain('חשבונית זיכוי');
    expect(html).not.toContain('חשבונית מס/קבלה');
    expect(html).toContain('MOCK-CN-000007');
    expect(html).toContain('200.00 ₪');
  });
});
