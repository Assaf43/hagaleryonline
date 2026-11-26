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

  it('order_paid points to the tax invoice on the order page, in html and text', () => {
    const m = renderEmail('order_paid', paid);
    expect(m.html).toContain('החשבונית זמינה בעמוד ההזמנה.');
    expect(m.text).toContain('החשבונית זמינה בעמוד ההזמנה.');
  });

  it('refund with a credit note points to it on the order page; without one it does not', () => {
    const base = { number: 100123, customerName: 'דנה', link: LINK, amount: 474_000 };
    const withNote = renderEmail('refund', { ...base, creditNote: true });
    expect(withNote.html).toContain('חשבונית הזיכוי זמינה בעמוד ההזמנה.');
    expect(withNote.text).toContain('חשבונית הזיכוי זמינה בעמוד ההזמנה.');
    const without = renderEmail('refund', { ...base, creditNote: false });
    expect(without.html).not.toContain('חשבונית הזיכוי');
    expect(without.text).not.toContain('חשבונית הזיכוי');
  });

  it('refund shows the formatted amount in subject, html and text', () => {
    const m = renderEmail('refund', {
      number: 100123,
      customerName: 'דנה',
      link: LINK,
      amount: 474_000,
      creditNote: true,
    });
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

describe('support e-mail templates (spec §7.1)', () => {
  it('ticket_received: the quoted subject with the ticket number, escaped name, plain text', () => {
    const m = renderEmail('ticket_received', { ticketNumber: 5001, customerName: 'דנה <b>כהן</b>' });
    expect(m.subject).toBe('קיבלנו את פנייתך, מספר פנייה 5001');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('<bdi>5001</bdi>');
    expect(m.html).not.toContain('<b>כהן</b>');
    expect(m.text).toContain('קיבלנו את פנייתך, מספר פנייה 5001');
  });

  it('ticket_alert: number, type label and order number, with or without an order', () => {
    const withOrder = renderEmail('ticket_alert', { ticketNumber: 5002, type: 'damaged', orderNumber: 100123 });
    expect(withOrder.subject).toBe('פנייה חדשה 5002: מוצר פגום');
    expect(withOrder.html).toContain('<bdi>100123</bdi>');
    expect(withOrder.text).toContain('הזמנה 100123');
    const contact = renderEmail('ticket_alert', { ticketNumber: 5003, type: 'contact', orderNumber: null });
    expect(contact.subject).toBe('פנייה חדשה 5003: פנייה כללית');
    expect(contact.text).not.toContain('הזמנה');
  });

  it('store_welcome: how a quick account signs in, with the masked phone and the link, never the store', () => {
    const m = renderEmail('store_welcome', {
      customerName: 'רון <b>כהן</b>',
      phoneMasked: '050-***-4567',
      link: 'https://shop.test/account',
    });
    expect(m.subject).toBe('החשבון שלכם בנסטו מוכן');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('<bdi>050-***-4567</bdi>');
    expect(m.html).toContain('https://shop.test/account');
    expect(m.html).not.toContain('<b>כהן</b>');
    expect(m.text).toContain('050-***-4567');
    expect(m.text).toContain('קוד ב־SMS');
    expect(m.text).toContain('להגדיר סיסמה');
    expect(m.text).toContain('https://shop.test/account');
    for (const part of [m.subject, m.html, m.text]) expect(part).not.toMatch(/חנות|מוכר|סניף/);
  });
});

describe('marketing messages (decisions 95–96)', () => {
  it('newsletter_confirm: the confirm button and the unsubscribe link in html and text, no name, never the store', () => {
    const m = renderEmail('newsletter_confirm', {
      confirmUrl: 'https://shop.test/newsletter/confirm?t=c1',
      unsubscribeUrl: 'https://shop.test/newsletter/unsubscribe?t=u1',
    });
    expect(m.subject).toBe('אישור קבלת עדכונים ומבצעים מנסטו');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('href="https://shop.test/newsletter/confirm?t=c1"');
    expect(m.html).toContain('href="https://shop.test/newsletter/unsubscribe?t=u1"');
    expect(m.text).toContain('אישור ההרשמה: https://shop.test/newsletter/confirm?t=c1');
    expect(m.text).toContain('להסרה מרשימת התפוצה: https://shop.test/newsletter/unsubscribe?t=u1');
    expect(m.text).toContain('7 ימים');
    for (const part of [m.subject, m.html, m.text]) expect(part).not.toMatch(/חנות|מוכר|סניף/);
  });

  it('store_consent SMS: the confirm link only', () => {
    expect(renderSms('store_consent', { url: 'https://shop.test/newsletter/confirm?t=c1' })).toBe(
      'NESTO: לאישור קבלת עדכונים ומבצעים במייל, היכנסו לקישור: https://shop.test/newsletter/confirm?t=c1',
    );
  });
});

describe('personal-code messages (decisions 93–94, 96)', () => {
  const data = {
    customerName: 'נועה <b>לוי</b>',
    code: 'NST-AB23CD45',
    labelHe: '10% <i>הנחה</i>',
    expiresOn: '17.12.2026',
    link: 'https://shop.test/account/benefits',
  };

  it('welcome_code e-mail: the code isolated in <bdi>, the label escaped, expiry, sign-in link, never the store', () => {
    const m = renderEmail('welcome_code', data);
    expect(m.subject).toBe('ברוכים הבאים לנסטו: קוד ההטבה שלך');
    expect(m.html).toContain('dir="rtl"');
    expect(m.html).toContain('<strong><bdi>NST-AB23CD45</bdi></strong>');
    expect(m.html).toContain('10% &lt;i&gt;הנחה&lt;/i&gt;');
    expect(m.html).not.toContain('<b>לוי</b>');
    expect(m.html).toContain('href="https://shop.test/account/benefits"');
    expect(m.text).toContain('הקוד שלך: NST-AB23CD45');
    expect(m.text).toContain('לרכישה הראשונה');
    expect(m.text).toContain('בתוקף עד 17.12.2026 לרכישה אחת');
    expect(m.text).toContain('כניסה לחשבון: https://shop.test/account/benefits');
    for (const part of [m.subject, m.html, m.text]) expect(part).not.toMatch(/חנות|מוכר|סניף/);
  });

  it('personal_code e-mail: the same body with its own subject and intro', () => {
    const m = renderEmail('personal_code', data);
    expect(m.subject).toBe('קוד הטבה אישי מנסטו');
    expect(m.html).toContain('<bdi>NST-AB23CD45</bdi>');
    expect(m.text).toContain('הכנו לך קוד הטבה אישי: 10% <i>הנחה</i>.');
    expect(m.text).not.toContain('לרכישה הראשונה');
  });

  it('welcome_code and personal_code SMS: brand, label, code, expiry and link', () => {
    expect(renderSms('welcome_code', data)).toBe(
      'NESTO: ברוכים הבאים למועדון! קוד ההטבה שלך לרכישה הראשונה (10% <i>הנחה</i>): NST-AB23CD45, בתוקף עד 17.12.2026. הזינו אותו בסל כשאתם מחוברים לחשבון: https://shop.test/account/benefits',
    );
    expect(renderSms('personal_code', data)).toBe(
      'NESTO: קוד הטבה אישי עבורך (10% <i>הנחה</i>): NST-AB23CD45, בתוקף עד 17.12.2026. הזינו אותו בסל כשאתם מחוברים לחשבון: https://shop.test/account/benefits',
    );
  });
});

describe('system_alert e-mail (spec 9b.6)', () => {
  const link = 'https://admin.example.test/system';
  const base = { summary: 'Payment provider timeout', at: '26.11.2026 14:05', link };

  it.each([
    ['new_error', 'NESTO: תקלה חדשה במערכת'],
    ['reopened_error', 'NESTO: תקלה חזרה'],
    ['backup_failed', 'NESTO: הגיבוי נכשל'],
    ['backup_missing', 'NESTO: לא בוצע גיבוי ב-26 השעות האחרונות'],
  ] as const)('%s has its subject, the summary, the time and the system link', (reason, subject) => {
    const m = renderEmail('system_alert', { reason, ...base });
    expect(m.subject).toBe(subject);
    expect(m.html).toContain('dir="rtl"');
    for (const part of [base.summary, base.at, link]) {
      expect(m.html).toContain(part);
      expect(m.text).toContain(part);
    }
  });

  it('has no query string and no e-mail address in its body, and escapes the summary', () => {
    const m = renderEmail('system_alert', { reason: 'new_error', ...base, summary: '<b>x</b>' });
    expect(m.html).not.toContain('<b>x</b>');
    expect(m.html).not.toMatch(/\?[a-z]+=/i);
    expect(m.html).not.toMatch(/[\w.+-]+@[\w-]+\.[a-z]{2,}/i);
    expect(m.text).not.toMatch(/\?[a-z]+=/i);
  });
});
