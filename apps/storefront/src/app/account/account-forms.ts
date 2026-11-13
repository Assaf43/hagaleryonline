import {
  CHECKOUT_EMAIL_PATTERN,
  CHECKOUT_FIELD_MESSAGES_HE,
  CHECKOUT_LIMITS,
  CHECKOUT_PHONE_PATTERN,
  CUSTOMER_PASSWORD_MAX,
  CUSTOMER_PASSWORD_MIN,
} from '@hg/models';

/** Spaces and dashes removed, "+972" read as "0": the form the API stores (05XXXXXXXX). */
export function normalizePhone(raw: string): string {
  return raw.replace(/[\s-]/g, '').replace(/^\+972/, '0');
}

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const isPhone = (phone: string): boolean => CHECKOUT_PHONE_PATTERN.test(phone);
export const isEmail = (email: string): boolean =>
  email.length <= CHECKOUT_LIMITS.emailMax && CHECKOUT_EMAIL_PATTERN.test(email);

export const PHONE_MESSAGE_HE = CHECKOUT_FIELD_MESSAGES_HE['contact.phone'];
export const EMAIL_MESSAGE_HE = CHECKOUT_FIELD_MESSAGES_HE['contact.email'];
export const NAME_MESSAGE_HE = CHECKOUT_FIELD_MESSAGES_HE['contact.fullName'];
export const PASSWORD_MESSAGE_HE = `הסיסמה צריכה להיות באורך של ${CUSTOMER_PASSWORD_MIN} עד ${CUSTOMER_PASSWORD_MAX} תווים`;
export const PASSWORD_REQUIRED_MESSAGE_HE = 'יש להזין סיסמה';
export const CODE_REQUIRED_MESSAGE_HE = 'יש להזין את הקוד בן 6 הספרות';

export const isValidPassword = (p: string): boolean =>
  p.length >= CUSTOMER_PASSWORD_MIN && p.length <= CUSTOMER_PASSWORD_MAX;

export const isValidName = (name: string): boolean =>
  name.trim().length >= CHECKOUT_LIMITS.fullNameMin && name.trim().length <= CHECKOUT_LIMITS.fullNameMax;
