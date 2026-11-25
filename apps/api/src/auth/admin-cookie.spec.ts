import { adminCookieOptions } from './auth.config.js';

describe('admin session cookie flags', () => {
  it('is not Secure in development without COOKIE_SECURE', () => {
    expect(adminCookieOptions({ cookieSecure: false, nodeEnv: 'development' }, false)).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: 'strict',
      path: '/api/admin',
    });
  });

  it('is Secure in production even when COOKIE_SECURE is unset', () => {
    expect(adminCookieOptions({ cookieSecure: false, nodeEnv: 'production' }, false).secure).toBe(true);
  });

  it('is Secure when COOKIE_SECURE=true', () => {
    expect(adminCookieOptions({ cookieSecure: true, nodeEnv: 'development' }, false).secure).toBe(true);
  });

  it('is a browser-session cookie unless remembered', () => {
    expect(adminCookieOptions({ cookieSecure: false, nodeEnv: 'test' }, false).maxAge).toBeUndefined();
    expect(adminCookieOptions({ cookieSecure: false, nodeEnv: 'test' }, true).maxAge).toBeGreaterThan(0);
  });
});
