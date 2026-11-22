import { BRAND } from '@hg/models';
import { bdi, button, emailLayout, esc, greeting, paragraph, type RenderedEmail } from './layout.js';

export interface StoreWelcomeData {
  customerName?: string;
  /** The account's phone, masked (`050-***-4567`): the sign-in by SMS code goes to it. */
  phoneMasked: string;
  /** Absolute link to the sign-in page (/account). */
  link: string;
}

const SIGN_IN = 'כניסה לחשבון';
const hello = (name: string | undefined): string => (name?.trim() ? `שלום ${name.trim()},` : 'שלום,');

/**
 * To a quick account (decision 85) once its first order is paid (spec §4.3): the account exists, how to sign in (an
 * SMS code to the phone) and that a password can be set in the account. Never mentions where the order was placed
 * (decision 43).
 */
export function storeWelcome(d: StoreWelcomeData): RenderedEmail {
  const subject = `החשבון שלכם ב${BRAND.nameHe} מוכן`;
  const opened = `פתחנו עבורכם חשבון ב${BRAND.nameHe}, ובו ההזמנות שלכם.`;
  // `wrap` isolates the phone in the html (bidi) and leaves it as is in the plain text.
  const how = (wrap: (v: string) => string) =>
    `כדי להיכנס, בחרו באתר בכניסה עם ״קוד ב־SMS״ והזינו את הקוד שיישלח לטלפון ${wrap(d.phoneMasked)}.`;
  const password = 'בחשבון אפשר להגדיר סיסמה, לאמת את כתובת המייל ולשמור כתובות למשלוח.';
  const html = emailLayout(
    subject,
    [
      greeting(d.customerName),
      paragraph(esc(opened)),
      paragraph(how(bdi)),
      paragraph(esc(password)),
      button(d.link, SIGN_IN),
    ].join('\n'),
  );
  const text = [hello(d.customerName), '', opened, how((v) => v), password, '', `${SIGN_IN}: ${d.link}`].join('\n');
  return { subject, html, text };
}
