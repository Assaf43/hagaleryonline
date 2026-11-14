import { SUPPORT_TICKET_TYPE_LABELS_HE, type SupportTicketType } from '@hg/models';
import { bdi, emailLayout, esc, greeting, paragraph, type RenderedEmail } from './layout.js';

export interface TicketReceivedData {
  ticketNumber: number;
  customerName?: string;
}

export interface TicketAlertData {
  ticketNumber: number;
  type: SupportTicketType;
  /** The order the ticket is about, or null. */
  orderNumber: number | null;
}

const WE_WILL_REPLY = 'נחזור אליך בהקדם.';
const SEE_INBOX = 'הפרטים המלאים בתיבת הפניות בממשק הניהול.';

const hello = (name: string | undefined): string => (name?.trim() ? `שלום ${name.trim()},` : 'שלום,');

/** To the customer (spec §7.1): the ticket number to quote. */
export function ticketReceived(d: TicketReceivedData): RenderedEmail {
  const subject = `קיבלנו את פנייתך, מספר פנייה ${d.ticketNumber}`;
  const html = emailLayout(
    subject,
    [
      greeting(d.customerName),
      paragraph(`קיבלנו את פנייתך, מספר פנייה ${bdi(d.ticketNumber)}.`),
      paragraph(esc(WE_WILL_REPLY)),
    ].join('\n'),
  );
  const text = [hello(d.customerName), '', `${subject}.`, WE_WILL_REPLY].join('\n');
  return { subject, html, text };
}

/**
 * To the business inbox (`SUPPORT_EMAIL`): the number, the type and the order only. The customer's details and words
 * stay in the admin inbox, not in a mailbox.
 */
export function ticketAlert(d: TicketAlertData): RenderedEmail {
  const type = SUPPORT_TICKET_TYPE_LABELS_HE[d.type];
  const subject = `פנייה חדשה ${d.ticketNumber}: ${type}`;
  const html = emailLayout(
    subject,
    [
      paragraph(`התקבלה פנייה חדשה ${bdi(d.ticketNumber)}: ${esc(type)}.`),
      d.orderNumber === null ? '' : paragraph(`הזמנה ${bdi(d.orderNumber)}`),
      paragraph(esc(SEE_INBOX)),
    ].join('\n'),
  );
  const text = [
    `התקבלה פנייה חדשה ${d.ticketNumber}: ${type}.`,
    ...(d.orderNumber === null ? [] : [`הזמנה ${d.orderNumber}`]),
    SEE_INBOX,
  ].join('\n');
  return { subject, html, text };
}
