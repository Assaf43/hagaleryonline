import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Post,
  Res,
  UseFilters,
  UseGuards,
  UseInterceptors,
  createParamDecorator,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import {
  CHECKOUT_LIMITS,
  type OtpSentResponse,
  type OtpVerifyResponse,
  type SignedInResponse,
  type SignUpResponse,
} from '@hg/models';
import { StorefrontOriginGuard } from '../auth/guards.js';
import { checkCustomerPassword } from '../auth/passwords.js';
import { Throttled, WriteThrottleGuard } from '../orders/write-throttle.js';
import { AccountError, badField, weakPassword } from './account-errors.js';
import { normalizeEmail, normalizePhone, normalizeTarget } from './contact-normalize.js';
import {
  CustomerAuthService,
  toMe,
  type ClientInfo,
  type NewCustomer,
  type SignedIn,
} from './customer-auth.service.js';
import { CUSTOMER_COOKIE, type ResolvedCustomer } from './customer-session.service.js';
import {
  CurrentCustomer,
  CustomerCookie,
  CustomerSessionGuard,
  OptionalCustomer,
  OptionalCustomerGuard,
} from './customer-session.guard.js';

type BodyRecord = Record<string, unknown>;

/** Every answer of the account API is personal: never cached (spec §6.3). */
@Injectable()
class NoStoreInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler) {
    ctx.switchToHttp().getResponse<Response>().setHeader('Cache-Control', 'no-store');
    return next.handle();
  }
}

/** Account errors as JSON, with `Retry-After` when they carry `retryAfterSeconds` (per-IP limit, password delay). */
@Catch(AccountError)
class AccountErrorFilter implements ExceptionFilter {
  catch(error: AccountError, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const body = error.getResponse() as BodyRecord;
    if (typeof body.retryAfterSeconds === 'number') res.setHeader('Retry-After', String(body.retryAfterSeconds));
    res.status(error.getStatus()).json(body);
  }
}

const SENT: OtpSentResponse = { sent: true };

/** IP, user agent and the incoming `hg_customer` cookie (a new sign-in ends that session). */
const Client = createParamDecorator((_: unknown, ctx: ExecutionContext): ClientInfo => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return {
    ip: req.ip,
    userAgent: req.get('user-agent'),
    previousToken: req.cookies?.[CUSTOMER_COOKIE] as string | undefined,
  };
});

/**
 * Customer accounts (spec §6.1, §6.2, ACC-01, NFR-12): sign-up, sign-in by password or one-time code, sign-out, the
 * current customer, password and contact changes, forgotten password. Every write needs the storefront origin.
 * Code requests count against `THROTTLE_OTP_LIMIT` per IP (inside `OtpService`); password and code attempts against
 * `THROTTLE_SIGNIN_LIMIT` (the `signin` bucket).
 */
@Controller('account')
@UseGuards(StorefrontOriginGuard, WriteThrottleGuard)
@UseInterceptors(NoStoreInterceptor)
@UseFilters(AccountErrorFilter)
export class CustomerAuthController {
  constructor(
    private readonly auth: CustomerAuthService,
    private readonly cookie: CustomerCookie,
  ) {}

  @Post('otp/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestCode(@Body() body: unknown, @Client() client: ClientInfo): Promise<OtpSentResponse> {
    const b = record(body);
    const channel = b.channel;
    if (channel !== 'sms' && channel !== 'email') throw badField('channel');
    const purpose = b.purpose;
    if (purpose !== 'sign_in' && purpose !== 'sign_up') throw badField('purpose');
    const target = channel === 'sms' ? normalizePhone(b.target) : normalizeEmail(b.target);
    if (!target) throw badField('target');
    await this.auth.requestCode(target, channel, purpose, client.ip);
    return SENT;
  }

  @Post('otp/verify')
  @HttpCode(HttpStatus.OK)
  @Throttled('signin')
  async verifyCode(
    @Body() body: unknown,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<OtpVerifyResponse> {
    const b = record(body);
    const code = codeOf(b.code);
    const purpose = b.purpose ?? 'sign_in';
    if (purpose !== 'sign_in' && purpose !== 'sign_up') throw badField('purpose');
    const parsed = normalizeTarget(b.target);
    if (!parsed) throw badField('target');
    const token = optionalToken(b.signUpToken);
    const result = await this.auth.verifyCode(parsed.target, parsed.channel, purpose, code, token, client);
    if ('signUpToken' in result)
      return { needsSignUp: true, signUpToken: result.signUpToken, verified: result.verified };
    return this.signIn(res, result);
  }

  @Post('sign-up')
  @HttpCode(HttpStatus.OK)
  async signUp(
    @Body() body: unknown,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignUpResponse> {
    const b = record(body);
    const details = parseDetails(b);
    const token = optionalToken(b.signUpToken);
    if (token === undefined) {
      await this.auth.startSignUp(details, client.ip);
      return { verify: true };
    }
    return this.signIn(res, await this.auth.signUpWithTicket(details, token, client));
  }

  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @Throttled('signin')
  async signInWithPassword(
    @Body() body: unknown,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignedInResponse> {
    const b = record(body);
    if (typeof b.password !== 'string' || b.password.length === 0 || b.password.length > 256)
      throw badField('password');
    return this.signIn(res, await this.auth.signIn(normalizeEmail(b.email), b.password, client));
  }

  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(OptionalCustomerGuard)
  async signOut(
    @OptionalCustomer() current: ResolvedCustomer | null,
    @Res({ passthrough: true }) res: Response,
  ): Promise<void> {
    if (current) await this.auth.signOut(current.session.id);
    this.cookie.clear(res);
  }

  @Get('me')
  @UseGuards(OptionalCustomerGuard)
  me(@OptionalCustomer() current: ResolvedCustomer | null, @Res() res: Response): void {
    // Sent explicitly: JSON `null` when signed out (Nest would send an empty body).
    res.status(HttpStatus.OK).json(current ? toMe(current.customer) : null);
  }

  @Post('password')
  @HttpCode(HttpStatus.OK)
  @Throttled('signin')
  @UseGuards(CustomerSessionGuard)
  async changePassword(@CurrentCustomer() current: ResolvedCustomer, @Body() body: unknown): Promise<SignedInResponse> {
    const b = record(body);
    const next = newPassword(b.next, 'next');
    if (b.current !== undefined && (typeof b.current !== 'string' || b.current.length > 256)) throw badField('current');
    return { customer: await this.auth.changePassword(current, b.current as string | undefined, next) };
  }

  @Post('contact/change')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(CustomerSessionGuard)
  async changeContact(
    @CurrentCustomer() current: ResolvedCustomer,
    @Body() body: unknown,
    @Client() client: ClientInfo,
  ): Promise<OtpSentResponse> {
    const b = record(body);
    const kind = kindOf(b.kind);
    const value = kind === 'phone' ? normalizePhone(b.value) : normalizeEmail(b.value);
    if (!value) throw badField('value');
    await this.auth.requestContactChange(current.customer, kind, value, client.ip);
    return SENT;
  }

  @Post('contact/confirm')
  @HttpCode(HttpStatus.OK)
  @Throttled('signin')
  @UseGuards(CustomerSessionGuard)
  async confirmContact(@CurrentCustomer() current: ResolvedCustomer, @Body() body: unknown): Promise<SignedInResponse> {
    const b = record(body);
    const kind = kindOf(b.kind);
    return { customer: await this.auth.confirmContactChange(current, kind, codeOf(b.code)) };
  }

  @Post('password/reset/request')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestReset(@Body() body: unknown, @Client() client: ClientInfo): Promise<OtpSentResponse> {
    const email = normalizeEmail(record(body).email);
    if (!email) throw badField('email');
    await this.auth.requestPasswordReset(email, client.ip);
    return SENT;
  }

  @Post('password/reset')
  @HttpCode(HttpStatus.OK)
  @Throttled('signin')
  async reset(
    @Body() body: unknown,
    @Client() client: ClientInfo,
    @Res({ passthrough: true }) res: Response,
  ): Promise<SignedInResponse> {
    const b = record(body);
    const email = normalizeEmail(b.email);
    if (!email) throw badField('email');
    const code = codeOf(b.code);
    const next = newPassword(b.next, 'next');
    return this.signIn(res, await this.auth.resetPassword(email, code, next, client));
  }

  private signIn(res: Response, { customer, token }: SignedIn): SignedInResponse {
    this.cookie.set(res, token);
    return { customer };
  }
}

function record(body: unknown): BodyRecord {
  return body && typeof body === 'object' && !Array.isArray(body) ? (body as BodyRecord) : {};
}

/** Any string up to 16 characters; the code check itself refuses anything but 6 digits. */
/** An optional `signUpToken` (one or two parts joined by '.'); 400 when it is not a short string. */
function optionalToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 160) throw badField('signUpToken');
  return value;
}

function codeOf(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 16) throw badField('code');
  return value.trim();
}

function kindOf(value: unknown): 'phone' | 'email' {
  if (value !== 'phone' && value !== 'email') throw badField('kind');
  return value;
}

function newPassword(value: unknown, field: string): string {
  if (typeof value !== 'string') throw badField(field);
  const problem = checkCustomerPassword(value);
  if (problem) throw weakPassword(problem, field);
  return value;
}

/** Name, phone, e-mail, optional password and the consent checkbox of a new account. */
function parseDetails(b: BodyRecord): NewCustomer {
  const fullName = typeof b.fullName === 'string' ? b.fullName.trim().replace(/\s+/g, ' ') : '';
  if (fullName.length < CHECKOUT_LIMITS.fullNameMin || fullName.length > CHECKOUT_LIMITS.fullNameMax)
    throw badField('fullName');
  const phone = normalizePhone(b.phone);
  if (!phone) throw badField('phone');
  const email = normalizeEmail(b.email);
  if (!email) throw badField('email');
  let password: string | undefined;
  if (b.password !== undefined && b.password !== null && b.password !== '')
    password = newPassword(b.password, 'password');
  if (b.marketingConsent !== undefined && typeof b.marketingConsent !== 'boolean') throw badField('marketingConsent');
  return { fullName, phone, email, password, marketingConsent: b.marketingConsent === true };
}
