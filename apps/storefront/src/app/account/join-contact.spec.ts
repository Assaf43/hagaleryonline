import { TestBed } from '@angular/core/testing';
import { JoinContact } from './join-contact';

describe('JoinContact', () => {
  beforeEach(() => {
    TestBed.configureTestingModule({});
    sessionStorage.clear();
  });

  it('keeps the checkout contact on the device for the order page and clears it', () => {
    const c = TestBed.inject(JoinContact);
    expect(c.read()).toBeNull();
    c.save({ fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.com' });
    expect(c.read()).toEqual({ fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.com' });
    c.clear();
    expect(c.read()).toBeNull();
  });

  it('ignores damaged stored data', () => {
    sessionStorage.setItem('hg.join-contact', '{"fullName":5}');
    expect(TestBed.inject(JoinContact).read()).toBeNull();
  });
});
