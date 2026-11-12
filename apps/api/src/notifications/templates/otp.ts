import { bdi, emailLayout, paragraph, type RenderedEmail } from './layout.js';

export interface OtpData {
  code: string;
}

/** The one text of the code, for the SMS and the plain-text part of the e-mail (spec §5.3). */
export const otpText = (d: OtpData): string => `קוד האימות שלך: ${d.code}. תקף ל־10 דקות.`;

export function otpEmail(d: OtpData): RenderedEmail {
  const subject = 'קוד האימות שלך';
  const html = emailLayout(
    subject,
    [
      paragraph(`קוד האימות שלך: ${bdi(d.code)}. תקף ל־10 דקות.`),
      paragraph('אם לא ביקשת קוד, אפשר להתעלם מההודעה.'),
    ].join('\n'),
  );
  return { subject, html, text: otpText(d) };
}
