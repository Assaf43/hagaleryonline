import {
  CHECKOUT_FIELD_MESSAGES_HE,
  CHECKOUT_LIMITS,
  type CheckoutField,
  type CustomerAddressInput,
  type CustomerAddressView,
  type LocalityOption,
} from '@hg/models';
import { parseFloor } from '../checkout/checkout-form';

/** The saved-address form as the customer typed it (the floor as text until it is checked). */
export interface AddressForm {
  locality: LocalityOption | null;
  street: string;
  houseNumber: string;
  apartment: string;
  floor: string;
  hasElevator: boolean;
  notes: string;
  isDefault: boolean;
}

export type AddressField = Extract<CheckoutField, `address.${string}`>;
export type AddressErrors = Partial<Record<AddressField, string>>;

/** Element id of each field's control; its error is `<id>-error`. */
export const ADDRESS_FIELD_IDS: Record<AddressField, string> = {
  'address.localityId': 'ad-locality',
  'address.street': 'ad-street',
  'address.houseNumber': 'ad-houseNumber',
  'address.apartment': 'ad-apartment',
  'address.floor': 'ad-floor',
  'address.hasElevator': 'ad-hasElevator',
  'address.notes': 'ad-notes',
};

export const ADDRESS_FIELDS = Object.keys(ADDRESS_FIELD_IDS) as AddressField[];

export function isAddressField(field: unknown): field is AddressField {
  return typeof field === 'string' && (ADDRESS_FIELDS as string[]).includes(field);
}

export function emptyAddressForm(): AddressForm {
  return {
    locality: null,
    street: '',
    houseNumber: '',
    apartment: '',
    floor: '',
    hasElevator: false,
    notes: '',
    isDefault: false,
  };
}

export function formFromAddress(a: CustomerAddressView): AddressForm {
  return {
    locality: { id: a.localityId, nameHe: a.localityNameHe },
    street: a.street,
    houseNumber: a.houseNumber,
    apartment: a.apartment ?? '',
    floor: String(a.floor),
    hasElevator: a.hasElevator,
    notes: a.notes ?? '',
    isDefault: a.isDefault,
  };
}

/** Every invalid field with the checkout's own message (the API checks the same rules). */
export function validateAddress(f: AddressForm): AddressErrors {
  const errors: AddressErrors = {};
  const fail = (field: AddressField) => (errors[field] = CHECKOUT_FIELD_MESSAGES_HE[field]);
  const L = CHECKOUT_LIMITS;
  if (!f.locality) fail('address.localityId');
  const street = f.street.trim();
  if (!street || street.length > L.streetMax) fail('address.street');
  const house = f.houseNumber.trim();
  if (!house || house.length > L.houseNumberMax) fail('address.houseNumber');
  if (f.apartment.trim().length > L.apartmentMax) fail('address.apartment');
  if (parseFloor(f.floor) === null) fail('address.floor');
  if (f.notes.trim().length > L.notesMax) fail('address.notes');
  return errors;
}

/** The request for a form that passed `validateAddress`. */
export function toAddressInput(f: AddressForm): CustomerAddressInput {
  return {
    localityId: f.locality!.id,
    street: f.street.trim(),
    houseNumber: f.houseNumber.trim(),
    apartment: f.apartment.trim() || null,
    floor: parseFloor(f.floor)!,
    hasElevator: f.hasElevator,
    notes: f.notes.trim() || null,
    isDefault: f.isDefault,
  };
}
