import { HttpErrorResponse } from '@angular/common/http';
import { storeErrorMessage } from './store-errors';

const invalid = (field: string) =>
  new HttpErrorResponse({ status: 400, error: { statusCode: 400, code: 'invalid_input', field } });

describe('store sale error messages', () => {
  it('names the phone, the e-mail and the new customer fields', () => {
    expect(storeErrorMessage(invalid('phone'))).toBe('מספר הנייד לא תקין');
    expect(storeErrorMessage(invalid('email'))).toBe('כתובת המייל לא תקינה');
    expect(storeErrorMessage(invalid('newCustomer.email'))).toBe('כתובת המייל לא תקינה');
    expect(storeErrorMessage(invalid('newCustomer'))).toBe('יש להזין שם מלא ומייל');
    expect(storeErrorMessage(invalid('newCustomer.fullName'))).toBe('יש להזין שם מלא ומייל');
  });

  it('never shows the store-settings text for a bare phone or address', () => {
    expect(storeErrorMessage(invalid('phone'))).not.toContain('עד 200 תווים');
    expect(storeErrorMessage(invalid('address'))).toBe('משהו השתבש. נסו שוב.');
  });

  it('keeps the other codes of the screen', () => {
    const err = new HttpErrorResponse({ status: 409, error: { code: 'customer_not_confirmed' } });
    expect(storeErrorMessage(err)).toContain('אישור הלקוח פג');
  });
});
