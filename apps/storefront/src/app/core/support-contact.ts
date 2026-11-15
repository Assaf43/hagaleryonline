/**
 * Customer-service contact shown where the customer is sent to the business (cancelling a paid order, the contact
 * page). INTERIM: every value here is a PLACEHOLDER until the business supplies the real phone number, e-mail address
 * and WhatsApp number (spec §9 item 6). `whatsapp` is digits only, in international form (no "+"), for
 * `https://wa.me/<number>`.
 */
export const SUPPORT_CONTACT = {
  phone: '03-0000000',
  email: 'service@example.test',
  whatsapp: '972000000000',
} as const;

/** The WhatsApp chat link of a number in international form without "+". */
export const whatsappLink = (number: string): string => `https://wa.me/${number}`;
