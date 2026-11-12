import { formatPrice } from '@hg/models';
import { renderEmail, renderSms, type OrderPaidData } from './templates/index.js';
import { maskEmail, maskPhone } from './masking.js';

const LINK = 'https://shop.test/order/100123?t=tok';
const paid: OrderPaidData = {
  number: 100123,
  customerName: 'דנה <b>כהן</b>',
  link: LINK,
  lines: [{ modelName: 'ALBA', nameHe: 'ספה תלת מושבית', optionLabels: ['בז׳'], quantity: 2, lineTotal: 474_000 }],
  subtotal: 474_000,
  discount: 10_000,
  shippingTotal: 15_000,
  total: 479_000,
  deliveryDays: 14,
};

describe('e-mail templates (spec §5.2)', () => {
  it('order_paid: subject, RTL html, key values, link, escaped names, plain text', () => {
    const m = renderEmail('order_paid', paid);
    expect(m.subject).toBe('ההזמנה 100123 התקבלה');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('lang="he"');
    for (const part of ['ALBA', 'ספה תלת מושבית', formatPrice(479_000), formatPrice(474_000), '14', LINK])
      expect(m.html).toContain(part);
    expect(m.html).not.toContain('<b>כהן</b>');
    expect(m.html).toContain('&lt;b&gt;');
    expect(m.text).toContain(LINK);
    expect(m.text).toContain(formatPrice(479_000));
    expect(m.text).not.toContain('<table');
  });

  it.each([
    ['status_shipped', 'ההזמנה 100123 בדרך אליך'],
    ['status_delivered', 'ההזמנה 100123 סופקה'],
    ['order_cancelled', 'ההזמנה 100123 בוטלה'],
  ] as const)('%s has its subject, rtl html and the order link', (template, subject) => {
    const m = renderEmail(template, { number: 100123, customerName: 'דנה', link: LINK });
    expect(m.subject).toBe(subject);
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain(LINK);
    expect(m.text).toContain(LINK);
  });

  it('refund shows the formatted amount in subject, html and text', () => {
    const m = renderEmail('refund', { number: 100123, customerName: 'דנה', link: LINK, amount: 474_000 });
    expect(m.subject).toBe(`בוצע החזר של ${formatPrice(474_000)}`);
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain(formatPrice(474_000));
    expect(m.text).toContain(formatPrice(474_000));
  });

  it('otp e-mail carries the code and the 10 minute validity', () => {
    const m = renderEmail('otp', { code: '123456' });
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('123456');
    expect(m.text).toContain('קוד האימות שלך: 123456. תקף ל־10 דקות.');
  });
});

describe('sms templates', () => {
  it('delivery_slot', () => {
    const text = renderSms('delivery_slot', {
      number: 100123,
      date: '15.12.2026',
      from: '10:00',
      to: '14:00',
      url: 'https://shop.test/delivery/abc',
    });
    expect(text).toBe(
      'NESTO: האספקה של הזמנה 100123 מתואמת ל־15.12.2026 בין 10:00 ל־14:00. לאישור או לשינוי: https://shop.test/delivery/abc',
    );
  });

  it('otp', () => {
    expect(renderSms('otp', { code: '654321' })).toBe('קוד האימות שלך: 654321. תקף ל־10 דקות.');
  });
});

describe('masking', () => {
  it('e-mail keeps the first letter and the domain', () => {
    expect(maskEmail('dana@example.test')).toBe('d***@example.test');
    expect(maskEmail('weird')).toBe('***');
  });

  it('phone keeps the prefix and the last four digits', () => {
    expect(maskPhone('0501234567')).toBe('050-***-4567');
    expect(maskPhone('050-123-1234')).toBe('050-***-1234');
    expect(maskPhone('+972501231234')).toBe('050-***-1234');
    expect(maskPhone('123')).toBe('***');
  });
});
