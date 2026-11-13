import { CanActivate, ExecutionContext, Injectable, createParamDecorator } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { CookieOptions, Request, Response } from 'express';
import { AuthConfig } from '../auth/auth.config.js';
import { notAuthenticated } from './account-errors.js';
import {
  CUSTOMER_COOKIE,
  CUSTOMER_SESSION_MS,
  CustomerSessionService,
  type ResolvedCustomer,
} from './customer-session.service.js';

type CustomerRequest = Request & { customer?: ResolvedCustomer | null };

/** Writes and clears the `hg_customer` cookie: httpOnly, SameSite=Lax, path /, Secure in production (spec §6.2). */
@Injectable()
export class CustomerCookie {
  private readonly options: CookieOptions;

  constructor(auth: AuthConfig, config: ConfigService) {
    const secure = auth.cookieSecure || config.get<string>('NODE_ENV') === 'production';
    this.options = { httpOnly: true, sameSite: 'lax', secure, path: '/' };
  }

  set(res: Response, token: string): void {
    res.cookie(CUSTOMER_COOKIE, token, { ...this.options, maxAge: CUSTOMER_SESSION_MS });
  }

  clear(res: Response): void {
    res.clearCookie(CUSTOMER_COOKIE, this.options);
  }
}

/** Resolves the cookie once per request and resends it when the session was renewed. */
async function resolveInto(
  ctx: ExecutionContext,
  sessions: CustomerSessionService,
  cookie: CustomerCookie,
): Promise<ResolvedCustomer | null> {
  const http = ctx.switchToHttp();
  const req = http.getRequest<CustomerRequest>();
  if (req.customer !== undefined) return req.customer;
  const token = req.cookies?.[CUSTOMER_COOKIE] as string | undefined;
  const resolved = await sessions.resolve(token);
  if (resolved?.renewed && token) cookie.set(http.getResponse<Response>(), token);
  req.customer = resolved;
  return resolved;
}

/** The route needs a signed-in customer: 401 `not_authenticated` otherwise. */
@Injectable()
export class CustomerSessionGuard implements CanActivate {
  constructor(
    private readonly sessions: CustomerSessionService,
    private readonly cookie: CustomerCookie,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    if (!(await resolveInto(ctx, this.sessions, this.cookie))) throw notAuthenticated();
    return true;
  }
}

/** The customer is optional (checkout, cart, `GET me`): `@OptionalCustomer()` is null when signed out. */
@Injectable()
export class OptionalCustomerGuard implements CanActivate {
  constructor(
    private readonly sessions: CustomerSessionService,
    private readonly cookie: CustomerCookie,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    await resolveInto(ctx, this.sessions, this.cookie);
    return true;
  }
}

/** The signed-in customer (needs `CustomerSessionGuard`). */
export const CurrentCustomer = createParamDecorator((_: unknown, ctx: ExecutionContext): ResolvedCustomer => {
  const customer = ctx.switchToHttp().getRequest<CustomerRequest>().customer;
  if (!customer) throw notAuthenticated();
  return customer;
});

/** The customer when signed in, else null (needs `OptionalCustomerGuard`). */
export const OptionalCustomer = createParamDecorator(
  (_: unknown, ctx: ExecutionContext): ResolvedCustomer | null =>
    ctx.switchToHttp().getRequest<CustomerRequest>().customer ?? null,
);
