import { CHECKOUT_EMAIL_PATTERN, CHECKOUT_LIMITS, CHECKOUT_PHONE_PATTERN, type OtpChannel } from '@hg/models';

/**
 * The stored form of a phone or e-mail (spec §3): an Israeli mobile 05XXXXXXXX, an e-mail trimmed and lower-cased.
 * Every lookup, uniqueness check and code target uses these, so "+972-50…" and "050…" are one account.
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 32) return null;
  let phone = raw.replace(/[\s-]/g, '');
  if (phone.startsWith('+972')) phone = `0${phone.slice(4)}`;
  return CHECKOUT_PHONE_PATTERN.test(phone) ? phone : null;
}

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email.length > CHECKOUT_LIMITS.emailMax) return null;
  return CHECKOUT_EMAIL_PATTERN.test(email) ? email : null;
}

/** A sign-in target typed in one field: an e-mail when it has an @, else a phone. */
export function normalizeTarget(raw: unknown): { channel: OtpChannel; target: string } | null {
  if (typeof raw !== 'string') return null;
  if (raw.includes('@')) {
    const email = normalizeEmail(raw);
    return email ? { channel: 'email', target: email } : null;
  }
  const phone = normalizePhone(raw);
  return phone ? { channel: 'sms', target: phone } : null;
}
