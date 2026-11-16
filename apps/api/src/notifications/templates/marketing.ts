import { BRAND } from '@hg/models';
import { button, emailLayout, esc, greeting, paragraph, type RenderedEmail } from './layout.js';

export interface NewsletterConfirmData {
  /** Absolute link to /newsletter/confirm?t={token} (valid 7 days). */
  confirmUrl: string;
  /** Absolute link to /newsletter/unsubscribe?t={token}: in every message we send about marketing (CLAUDE.md §4.4). */
  unsubscribeUrl: string;
}

export interface StoreConsentSmsData {
  /** Absolute link to /newsletter/confirm?t={token}: the page shows the e-mail the updates go to. */
  url: string;
}

const CONFIRM = 'אישור ההרשמה';
const UNSUBSCRIBE = 'להסרה מרשימת התפוצה';

/**
 * Double opt-in (decision 95): a marketing consent given without a verified e-mail (guest checkout, the newsletter
 * form) is recorded only when this link is opened and confirmed. No name and nothing typed by whoever asked: the
 * address may not be theirs.
 */
export function newsletterConfirm(d: NewsletterConfirmData): RenderedEmail {
  const subject = `אישור קבלת עדכונים ומבצעים מ${BRAND.nameHe}`;
  const asked = 'ביקשת לקבל מאיתנו עדכונים ומבצעים במייל. כדי שנתחיל לשלוח, יש לאשר את ההרשמה.';
  const ignore = 'הקישור בתוקף 7 ימים. אם לא ביקשת זאת, אפשר להתעלם מהמייל ולא נשלח אליך עדכונים.';
  const html = emailLayout(
    subject,
    [
      greeting(undefined),
      paragraph(esc(asked)),
      button(d.confirmUrl, CONFIRM),
      paragraph(esc(ignore)),
      paragraph(`<a href="${esc(d.unsubscribeUrl)}">${esc(UNSUBSCRIBE)}</a>`),
    ].join('\n'),
  );
  const text = [
    'שלום,',
    '',
    asked,
    `${CONFIRM}: ${d.confirmUrl}`,
    '',
    ignore,
    `${UNSUBSCRIBE}: ${d.unsubscribeUrl}`,
  ].join('\n');
  return { subject, html, text };
}

/** The store seller ticked the marketing box (decision 96): consent counts only once the customer confirms. */
export const storeConsentSms = (d: StoreConsentSmsData): string =>
  `${BRAND.name}: לאישור קבלת עדכונים ומבצעים במייל, היכנסו לקישור: ${d.url}`;
