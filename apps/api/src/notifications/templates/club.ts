import { BRAND } from '@hg/models';
import { bdi, button, emailLayout, esc, greeting, paragraph, type RenderedEmail } from './layout.js';

/** A personal code's message (decisions 93–94): the welcome code of a new account, or a code issued by staff. */
export interface PersonalCodeMessageData {
  customerName?: string;
  /** The code itself: this message is how it reaches the customer. */
  code: string;
  /** The template's name (the label the cart's discount line shows). */
  labelHe: string;
  /** Display date of the expiry in Israel, e.g. 17.12.2026. */
  expiresOn: string;
  /** Absolute link to the sign-in / account page (/account/benefits). */
  link: string;
}

const SIGN_IN = 'כניסה לחשבון';
const hello = (name: string | undefined): string => (name?.trim() ? `שלום ${name.trim()},` : 'שלום,');
const howTo = (expiresOn: string) =>
  `הקוד בתוקף עד ${expiresOn} לרכישה אחת. הזינו אותו בסל הקניות כשאתם מחוברים לחשבון.`;

function codeEmail(subject: string, intro: string, d: PersonalCodeMessageData): RenderedEmail {
  const html = emailLayout(
    subject,
    [
      greeting(d.customerName),
      paragraph(esc(intro)),
      paragraph(`הקוד שלך: <strong>${bdi(d.code)}</strong>`),
      paragraph(esc(howTo(d.expiresOn))),
      button(d.link, SIGN_IN),
    ].join('\n'),
  );
  const text = [
    hello(d.customerName),
    '',
    intro,
    `הקוד שלך: ${d.code}`,
    howTo(d.expiresOn),
    '',
    `${SIGN_IN}: ${d.link}`,
  ].join('\n');
  return { subject, html, text };
}

/** To a new website account (decision 93): its welcome code for the first purchase. */
export function welcomeCodeEmail(d: PersonalCodeMessageData): RenderedEmail {
  return codeEmail(
    `ברוכים הבאים ל${BRAND.nameHe}: קוד ההטבה שלך`,
    `שמחים שהצטרפת למועדון הלקוחות של ${BRAND.nameHe}. לרכישה הראשונה הכנו לך קוד הטבה אישי: ${d.labelHe}.`,
    d,
  );
}

/** A code staff issued from the customer's profile (decision 94). */
export function personalCodeEmail(d: PersonalCodeMessageData): RenderedEmail {
  return codeEmail(`קוד הטבה אישי מ${BRAND.nameHe}`, `הכנו לך קוד הטבה אישי: ${d.labelHe}.`, d);
}

/** To a store quick account's verified phone (decision 96): it may have no verified e-mail. */
export const welcomeCodeSms = (d: PersonalCodeMessageData): string =>
  `${BRAND.name}: ברוכים הבאים למועדון! קוד ההטבה שלך לרכישה הראשונה (${d.labelHe}): ${d.code}, בתוקף עד ${d.expiresOn}. הזינו אותו בסל כשאתם מחוברים לחשבון: ${d.link}`;

export const personalCodeSms = (d: PersonalCodeMessageData): string =>
  `${BRAND.name}: קוד הטבה אישי עבורך (${d.labelHe}): ${d.code}, בתוקף עד ${d.expiresOn}. הזינו אותו בסל כשאתם מחוברים לחשבון: ${d.link}`;
