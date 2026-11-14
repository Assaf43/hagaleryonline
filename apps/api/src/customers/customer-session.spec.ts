import { customerCookieOptions } from './customer-session.guard.js';

describe('customerCookieOptions (spec §6.2)', () => {
  it('httpOnly, SameSite=Lax, path / everywhere', () => {
    expect(customerCookieOptions(false, 'development')).toEqual({
      httpOnly: true,
      sameSite: 'lax',
      secure: false,
      path: '/',
    });
  });

  it('Secure in production, or when COOKIE_SECURE=true', () => {
    expect(customerCookieOptions(false, 'production').secure).toBe(true);
    expect(customerCookieOptions(true, 'development').secure).toBe(true);
  });
});
