import { CHECKOUT_FIELD_MESSAGES_HE } from '@hg/models';
import { addressView } from './account.testing';
import { emptyAddressForm, formFromAddress, toAddressInput, validateAddress, type AddressForm } from './address-form';

const valid = (over: Partial<AddressForm> = {}): AddressForm => ({
  ...emptyAddressForm(),
  locality: { id: 5000, nameHe: 'תל אביב - יפו' },
  street: 'הרצל',
  houseNumber: '12',
  floor: '3',
  ...over,
});

describe('address form', () => {
  it('accepts a complete address', () => {
    expect(validateAddress(valid())).toEqual({});
  });

  it('requires a picked locality, a street, a house number and a floor, with the shared messages', () => {
    const errors = validateAddress(emptyAddressForm());
    expect(errors['address.localityId']).toBe(CHECKOUT_FIELD_MESSAGES_HE['address.localityId']);
    expect(errors['address.street']).toBe(CHECKOUT_FIELD_MESSAGES_HE['address.street']);
    expect(errors['address.houseNumber']).toBe(CHECKOUT_FIELD_MESSAGES_HE['address.houseNumber']);
    expect(errors['address.floor']).toBe(CHECKOUT_FIELD_MESSAGES_HE['address.floor']);
  });

  it('limits lengths and the floor range', () => {
    expect(validateAddress(valid({ street: 'א'.repeat(81) }))['address.street']).toBeTruthy();
    expect(validateAddress(valid({ houseNumber: '1'.repeat(11) }))['address.houseNumber']).toBeTruthy();
    expect(validateAddress(valid({ apartment: '1'.repeat(11) }))['address.apartment']).toBeTruthy();
    expect(validateAddress(valid({ notes: 'x'.repeat(501) }))['address.notes']).toBeTruthy();
    expect(validateAddress(valid({ floor: '61' }))['address.floor']).toBeTruthy();
    expect(validateAddress(valid({ floor: '-1' }))['address.floor']).toBeTruthy();
    expect(validateAddress(valid({ floor: '0' }))).toEqual({});
  });

  it('builds the API input, trimmed, with empty optional fields as null', () => {
    expect(toAddressInput(valid({ street: ' הרצל ', apartment: ' ', notes: '', isDefault: true }))).toEqual({
      localityId: 5000,
      street: 'הרצל',
      houseNumber: '12',
      apartment: null,
      floor: 3,
      hasElevator: false,
      notes: null,
      isDefault: true,
    });
  });

  it('fills the form from a saved address', () => {
    const f = formFromAddress(addressView({ apartment: null, notes: 'פעמון שבור', floor: 0 }));
    expect(f).toMatchObject({
      locality: { id: 5000, nameHe: 'תל אביב - יפו' },
      street: 'הרצל',
      apartment: '',
      floor: '0',
      notes: 'פעמון שבור',
      isDefault: true,
    });
  });
});
