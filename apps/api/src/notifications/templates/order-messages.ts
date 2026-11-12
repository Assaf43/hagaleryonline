import { BRAND, formatPrice } from '@hg/models';
import { bdi, button, emailLayout, esc, greeting, paragraph, type RenderedEmail } from './layout.js';

export interface OrderLinkData {
  number: number;
  customerName?: string;
  /** Absolute link to /order/{number}?t={publicToken}. */
  link: string;
}

export interface OrderPaidLine {
  modelName: string;
  nameHe: string;
  optionLabels: string[];
  quantity: number;
  /** Agorot. */
  lineTotal: number;
}

export interface OrderPaidData extends OrderLinkData {
  lines: OrderPaidLine[];
  /** Agorot, everything below. */
  subtotal: number;
  discount: number;
  shippingTotal: number;
  total: number;
  /** Business days of the slowest line (CRT-04); null when no estimate applies. */
  deliveryDays: number | null;
}

export interface RefundData extends OrderLinkData {
  /** Agorot. */
  amount: number;
  /** True when a credit note is issued for this refund (every refund except a late payment's). */
  creditNote: boolean;
}

const VIEW_ORDER = 'לצפייה בהזמנה ובמעקב אחריה';
/** The tax documents are not attached: the customer opens them on the order page (decision 81). */
const INVOICE_ON_PAGE = 'החשבונית זמינה בעמוד ההזמנה.';
const CREDIT_NOTE_ON_PAGE = 'חשבונית הזיכוי זמינה בעמוד ההזמנה.';

const lineName = (l: OrderPaidLine): string => [l.nameHe, ...l.optionLabels].join(' · ');
const hello = (name: string | undefined): string => (name?.trim() ? `שלום ${name.trim()},` : 'שלום,');

export function orderPaid(d: OrderPaidData): RenderedEmail {
  const subject = `ההזמנה ${d.number} התקבלה`;
  const estimate = d.deliveryDays === null ? null : `זמן אספקה משוער: עד ${d.deliveryDays} ימי עסקים`;
  const rows = d.lines
    .map(
      (l) =>
        `<tr><td style="padding:8px 0;border-bottom:1px solid #eeeeee;"><bdi dir="ltr">${esc(l.modelName)}</bdi> ${esc(lineName(l))}<br><span style="color:#666666;font-size:14px;">כמות: ${bdi(l.quantity)}</span></td>` +
        `<td style="padding:8px 0;border-bottom:1px solid #eeeeee;text-align:left;white-space:nowrap;">${bdi(formatPrice(l.lineTotal))}</td></tr>`,
    )
    .join('\n');
  const totalRow = (label: string, amount: string, strong = false) => {
    const weight = strong ? 'font-weight:700;' : '';
    return `<tr><td style="padding:4px 0;${weight}">${esc(label)}</td><td style="padding:4px 0;text-align:left;white-space:nowrap;${weight}">${bdi(amount)}</td></tr>`;
  };
  const table =
    'role="presentation" dir="rtl" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:16px;"';
  const html = emailLayout(
    subject,
    [
      greeting(d.customerName),
      paragraph(`תודה על ההזמנה ב${esc(BRAND.nameHe)}. התשלום התקבל והזמנה ${bdi(d.number)} נמצאת בטיפול.`),
      `<table ${table}>\n${rows}\n</table>`,
      `<table ${table}>`,
      totalRow('סכום ביניים', formatPrice(d.subtotal)),
      d.discount > 0 ? totalRow('הנחה', `−${formatPrice(d.discount)}`) : '',
      totalRow('משלוח', d.shippingTotal === 0 ? 'ללא עלות' : formatPrice(d.shippingTotal)),
      totalRow('סה״כ כולל מע״מ', formatPrice(d.total), true),
      `</table>`,
      estimate ? paragraph(esc(estimate)) : '',
      paragraph(esc(INVOICE_ON_PAGE)),
      button(d.link, VIEW_ORDER),
    ].join('\n'),
  );
  const text = [
    hello(d.customerName),
    '',
    `תודה על ההזמנה ב${BRAND.nameHe}. התשלום התקבל והזמנה ${d.number} נמצאת בטיפול.`,
    '',
    ...d.lines.map((l) => `${l.modelName} ${lineName(l)} x${l.quantity}: ${formatPrice(l.lineTotal)}`),
    '',
    `סכום ביניים: ${formatPrice(d.subtotal)}`,
    ...(d.discount > 0 ? [`הנחה: −${formatPrice(d.discount)}`] : []),
    `משלוח: ${d.shippingTotal === 0 ? 'ללא עלות' : formatPrice(d.shippingTotal)}`,
    `סה״כ כולל מע״מ: ${formatPrice(d.total)}`,
    ...(estimate ? ['', estimate] : []),
    '',
    INVOICE_ON_PAGE,
    `${VIEW_ORDER}: ${d.link}`,
  ].join('\n');
  return { subject, html, text };
}

/**
 * A short status e-mail: one sentence (given the order number or amount already formatted), then the order link,
 * with an optional plain-text note just before it.
 */
function simple(
  d: OrderLinkData,
  subject: string,
  sentence: (number: string, wrap: (v: string) => string) => string,
  note?: string,
) {
  const html = emailLayout(
    subject,
    [
      greeting(d.customerName),
      paragraph(sentence(String(d.number), bdi)),
      ...(note ? [paragraph(esc(note))] : []),
      button(d.link, VIEW_ORDER),
    ].join('\n'),
  );
  const text = [
    hello(d.customerName),
    '',
    sentence(String(d.number), (v) => v),
    '',
    ...(note ? [note] : []),
    `${VIEW_ORDER}: ${d.link}`,
  ].join('\n');
  return { subject, html, text } satisfies RenderedEmail;
}

export const statusShipped = (d: OrderLinkData) =>
  simple(d, `ההזמנה ${d.number} בדרך אליך`, (n, w) => `הזמנה ${w(n)} יצאה אליך. נשמח שתהיה זמינות לקבלת המשלוח.`);

export const statusDelivered = (d: OrderLinkData) =>
  simple(d, `ההזמנה ${d.number} סופקה`, (n, w) => `הזמנה ${w(n)} סופקה. תודה שבחרת ב${esc(BRAND.nameHe)}.`);

export const orderCancelled = (d: OrderLinkData) =>
  simple(d, `ההזמנה ${d.number} בוטלה`, (n, w) => `הזמנה ${w(n)} בוטלה. אם שולם סכום, ההחזר יישלח אליך בהודעה נפרדת.`);

export function refund(d: RefundData): RenderedEmail {
  const price = formatPrice(d.amount);
  return simple(
    d,
    `בוצע החזר של ${price}`,
    (n, w) => `בוצע החזר של ${w(price)} על הזמנה ${w(n)}. הסכום יופיע בחשבונך בהתאם לחברת האשראי.`,
    d.creditNote ? CREDIT_NOTE_ON_PAGE : undefined,
  );
}
