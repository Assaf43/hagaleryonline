import type { CheckoutRequest, LocalityOption, ShippingMethod } from '@hg/models';

/** What the customer typed, as strings (the floor too, until it is checked). */
export interface CheckoutForm {
  fullName: string;
  phone: string;
  email: string;
  locality: LocalityOption | null;
  street: string;
  houseNumber: string;
  apartment: string;
  floor: string;
  hasElevator: boolean;
  notes: string;
  method: ShippingMethod | null;
  acceptTerms: boolean;
}

/** Field keys as the API names them in a 400 (`field`), in the order the form shows them. */
export const FIELD_ORDER = [
  'contact.fullName',
  'contact.phone',
  'contact.email',
  'address.localityId',
  'address.street',
  'address.houseNumber',
  'address.apartment',
  'address.floor',
  'address.hasElevator',
  'address.notes',
  'method',
  'acceptTerms',
] as const;

export type CheckoutField = (typeof FIELD_ORDER)[number];
export type FieldErrors = Partial<Record<CheckoutField, string>>;

/** Element id of each field's control; its error is `<id>-error`. */
export const FIELD_IDS: Record<CheckoutField, string> = {
  'contact.fullName': 'chk-fullName',
  'contact.phone': 'chk-phone',
  'contact.email': 'chk-email',
  'address.localityId': 'chk-locality',
  'address.street': 'chk-street',
  'address.houseNumber': 'chk-houseNumber',
  'address.apartment': 'chk-apartment',
  'address.floor': 'chk-floor',
  'address.hasElevator': 'chk-hasElevator',
  'address.notes': 'chk-notes',
  method: 'chk-method',
  acceptTerms: 'chk-acceptTerms',
};

/** The same wording as the API's messages (apps/api/src/orders/checkout.service.ts), so both read alike. */
export const FIELD_MESSAGES: Record<CheckoutField, string> = {
  'contact.fullName': 'יש למלא שם מלא (2–80 תווים)',
  'contact.phone': 'יש להזין מספר טלפון נייד תקין, למשל 050-1234567',
  'contact.email': 'יש להזין כתובת דוא״ל תקינה',
  'address.localityId': 'יש לבחור יישוב מהרשימה',
  'address.street': 'יש למלא רחוב (עד 80 תווים)',
  'address.houseNumber': 'יש למלא מספר בית (עד 10 תווים)',
  'address.apartment': 'מספר הדירה ארוך מדי (עד 10 תווים)',
  'address.floor': 'יש להזין קומה בין 0 ל־60',
  'address.hasElevator': 'יש לציין אם יש מעלית',
  'address.notes': 'ההערות לשליח ארוכות מדי (עד 500 תווים)',
  method: 'יש לבחור שיטת משלוח',
  acceptTerms: 'יש לאשר את תנאי השימוש',
};

const PHONE = /^05\d{8}$/;
const EMAIL = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
export const MAX_FLOOR = 60;

/** The floor as a number, or null when it is not a whole number from 0 to 60. */
export function parseFloor(text: string): number | null {
  const t = text.trim();
  if (!/^\d{1,2}$/.test(t)) return null;
  const n = Number(t);
  return n <= MAX_FLOOR ? n : null;
}

/** Every invalid field with its message (the API checks the same rules and stops at the first). */
export function validateCheckout(f: CheckoutForm): FieldErrors {
  const errors: FieldErrors = {};
  const fail = (field: CheckoutField) => (errors[field] = FIELD_MESSAGES[field]);
  const name = f.fullName.trim();
  if (name.length < 2 || name.length > 80) fail('contact.fullName');
  if (!PHONE.test(f.phone.replace(/[\s-]/g, ''))) fail('contact.phone');
  const email = f.email.trim();
  if (email.length > 254 || !EMAIL.test(email)) fail('contact.email');
  if (!f.locality) fail('address.localityId');
  const street = f.street.trim();
  if (!street || street.length > 80) fail('address.street');
  const house = f.houseNumber.trim();
  if (!house || house.length > 10) fail('address.houseNumber');
  if (f.apartment.trim().length > 10) fail('address.apartment');
  if (parseFloor(f.floor) === null) fail('address.floor');
  if (f.notes.trim().length > 500) fail('address.notes');
  if (!f.method) fail('method');
  if (!f.acceptTerms) fail('acceptTerms');
  return errors;
}

/** The request for a form that passed `validateCheckout`. */
export function toCheckoutRequest(f: CheckoutForm): CheckoutRequest {
  return {
    contact: { fullName: f.fullName.trim(), phone: f.phone.trim(), email: f.email.trim() },
    address: {
      localityId: f.locality!.id,
      street: f.street.trim(),
      houseNumber: f.houseNumber.trim(),
      apartment: f.apartment.trim() || null,
      floor: parseFloor(f.floor)!,
      hasElevator: f.hasElevator,
      notes: f.notes.trim() || null,
    },
    method: f.method!,
    acceptTerms: true,
  };
}

/** The first field, in form order, that has an error. */
export function firstError(errors: FieldErrors): CheckoutField | null {
  return FIELD_ORDER.find((f) => errors[f]) ?? null;
}

export function isCheckoutField(field: unknown): field is CheckoutField {
  return typeof field === 'string' && (FIELD_ORDER as readonly string[]).includes(field);
}
