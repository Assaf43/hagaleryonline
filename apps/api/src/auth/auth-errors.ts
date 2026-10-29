import { HttpException, HttpStatus } from '@nestjs/common';
import type { AuthErrorCode } from '@hg/models';

/** Errors carry a machine-readable code; the admin app shows the Hebrew text. */
export class AuthError extends HttpException {
  constructor(status: HttpStatus, code: AuthErrorCode, extra: Record<string, unknown> = {}) {
    super({ statusCode: status, code, ...extra }, status);
  }
}

export const invalidCredentials = () => new AuthError(HttpStatus.UNAUTHORIZED, 'invalid_credentials');
export const invalidCode = () => new AuthError(HttpStatus.UNAUTHORIZED, 'invalid_code');
export const invalidLink = () => new AuthError(HttpStatus.GONE, 'invalid_link');
export const notAuthenticated = () => new AuthError(HttpStatus.UNAUTHORIZED, 'not_authenticated');
export const mfaRequired = () => new AuthError(HttpStatus.UNAUTHORIZED, 'mfa_required');
export const forbidden = () => new AuthError(HttpStatus.FORBIDDEN, 'forbidden');
export const tooManyAttempts = (retryAfterSeconds: number) =>
  new AuthError(HttpStatus.TOO_MANY_REQUESTS, 'too_many_attempts', { retryAfterSeconds });
export const weakPassword = (reason: string) => new AuthError(HttpStatus.BAD_REQUEST, 'weak_password', { reason });
