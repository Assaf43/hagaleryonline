import type { Response } from 'express';
import { writeCartCookie } from './cart.controller.js';
import { CART_COOKIE } from './cart-token.js';

/** The flags `writeCartCookie` sets on `hg_cart`, for this COOKIE_SECURE and NODE_ENV. */
function flags(cookieSecure: boolean, nodeEnv: string | undefined) {
  const cookie = vi.fn();
  const res = { cookie, clearCookie: vi.fn() } as unknown as Response;
  writeCartCookie({ cookieSecure, nodeEnv }, res, 'token', false);
  expect(cookie).toHaveBeenCalledWith(CART_COOKIE, 'token', expect.any(Object));
  return cookie.mock.calls[0][2] as Record<string, unknown>;
}

describe('hg_cart cookie flags (spec §3.1, same rule as hg_customer)', () => {
  it('httpOnly, SameSite=Lax, path / and not Secure in development', () => {
    expect(flags(false, 'development')).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
  });

  it('Secure in production, or when COOKIE_SECURE=true', () => {
    expect(flags(false, 'production').secure).toBe(true);
    expect(flags(true, 'development').secure).toBe(true);
  });
});
