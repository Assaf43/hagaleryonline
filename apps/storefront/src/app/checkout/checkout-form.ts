import {
  CHECKOUT_EMAIL_PATTERN,
  CHECKOUT_FIELDS,
  CHECKOUT_FIELD_MESSAGES_HE,
  CHECKOUT_LIMITS,
  CHECKOUT_PHONE_PATTERN,
  MAX_FLOOR,
  type CheckoutField,
  type CheckoutRequest,
  type LocalityOption,
  type ShippingMethod,
} from '@hg/models';

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
  /** The guest's marketing checkbox: never pre-checked (CLAUDE.md §4.4). */
  marketingConsent: boolean;
}

/** Field keys as the API names them in a 400 (`field`), in the order the form shows them. */
export const FIELD_ORDER = CHECKOUT_FIELDS;
export type { CheckoutField };
export type FieldErrors = Partial<Record<CheckoutField, string>>;

/** The marketing consent checkbox (no error of its own). */
export const MARKETING_ID = 'chk-marketing';

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

/** The API's own messages (`@hg/models`), so the form and a 400 read alike. */
export const FIELD_MESSAGES = CHECKOUT_FIELD_MESSAGES_HE;
const L = CHECKOUT_LIMITS;

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
  if (name.length < L.fullNameMin || name.length > L.fullNameMax) fail('contact.fullName');
  if (!CHECKOUT_PHONE_PATTERN.test(f.phone.replace(/[\s-]/g, ''))) fail('contact.phone');
  const email = f.email.trim();
  if (email.length > L.emailMax || !CHECKOUT_EMAIL_PATTERN.test(email)) fail('contact.email');
  if (!f.locality) fail('address.localityId');
  const street = f.street.trim();
  if (!street || street.length > L.streetMax) fail('address.street');
  const house = f.houseNumber.trim();
  if (!house || house.length > L.houseNumberMax) fail('address.houseNumber');
  if (f.apartment.trim().length > L.apartmentMax) fail('address.apartment');
  if (parseFloor(f.floor) === null) fail('address.floor');
  if (f.notes.trim().length > L.notesMax) fail('address.notes');
  if (!f.method) fail('method');
  if (!f.acceptTerms) fail('acceptTerms');
  return errors;
}

/** The request for a form that passed `validateCheckout`, with the total on screen (agorot, shipping included). */
export function toCheckoutRequest(f: CheckoutForm, expectedTotal: number): CheckoutRequest {
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
    expectedTotal,
    marketingConsent: f.marketingConsent,
  };
}

/** The first field, in form order, that has an error. */
export function firstError(errors: FieldErrors): CheckoutField | null {
  return FIELD_ORDER.find((f) => errors[f]) ?? null;
}

export function isCheckoutField(field: unknown): field is CheckoutField {
  return typeof field === 'string' && (FIELD_ORDER as readonly string[]).includes(field);
}
