import { HttpException, HttpStatus } from '@nestjs/common';
import type { AccountErrorCode } from '@hg/models';

/** Errors of /api/account/: `{ statusCode, code, ...details }`; the storefront shows the Hebrew text. */
export class AccountError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: AccountErrorCode,
    extra: Record<string, unknown> = {},
  ) {
    super({ statusCode: status, code, ...extra }, status);
  }
}

export const badField = (field: string) => new AccountError(HttpStatus.BAD_REQUEST, 'invalid_input', { field });
export const invalidCode = () => new AccountError(HttpStatus.UNAUTHORIZED, 'invalid_code');
/** One answer for an unknown e-mail, an account without a password and a wrong password. */
export const invalidCredentials = () => new AccountError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
export const invalidToken = () => new AccountError(HttpStatus.BAD_REQUEST, 'invalid_token');
/** The sign-up ticket does not cover this contact: its code was not entered (decision 80). */
export const notVerified = (field: 'phone' | 'email') =>
  new AccountError(HttpStatus.BAD_REQUEST, 'not_verified', { field });
export const wrongPassword = () => new AccountError(HttpStatus.BAD_REQUEST, 'wrong_password');
export const weakPassword = (reason: 'too_short' | 'too_long', field = 'password') =>
  new AccountError(HttpStatus.BAD_REQUEST, 'weak_password', { field, reason });
export const phoneTaken = () => new AccountError(HttpStatus.CONFLICT, 'phone_taken', { field: 'phone' });
export const emailTaken = () => new AccountError(HttpStatus.CONFLICT, 'email_taken', { field: 'email' });
export const notAuthenticated = () => new AccountError(HttpStatus.UNAUTHORIZED, 'not_authenticated');
/** Unknown, malformed or another customer's id: one answer, so ids of other accounts reveal nothing. */
export const accountNotFound = () => new AccountError(HttpStatus.NOT_FOUND, 'not_found');
export const addressLimit = () => new AccountError(HttpStatus.CONFLICT, 'address_limit');
/** The e-mail must wait after repeated wrong passwords (progressive delay). */
export const tooManyAttempts = (retryAfterSeconds: number) =>
  new AccountError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_attempts', { retryAfterSeconds });
/** The IP is over a per-IP limit. */
export const tooManyRequests = (retryAfterSeconds: number) =>
  new AccountError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_requests', { retryAfterSeconds });
