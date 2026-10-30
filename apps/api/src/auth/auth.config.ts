import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox } from './crypto.js';

export const SESSION_COOKIE = 'hg_admin_session';
/** The admin API lives under this path; the session cookie is scoped to it. */
export const ADMIN_API_PATH = '/api/admin';

/** Session lengths (decision 53). */
export const SESSION_IDLE_MS = 8 * 60 * 60_000;
export const SESSION_MAX_MS = 7 * 24 * 60 * 60_000;
export const TRUSTED_SESSION_MS = 30 * 24 * 60 * 60_000;
/** Between password and 2FA. */
export const PENDING_SESSION_MS = 10 * 60_000;

export const INVITE_TTL_MS = 7 * 24 * 60 * 60_000;
export const RESET_TTL_MS = 24 * 60 * 60_000;

@Injectable()
export class AuthConfig {
  readonly adminUrl: string;
  readonly cookieSecure: boolean;
  readonly secretBox: SecretBox;
  /** Password and code attempts per IP per 15 minutes (NFR-12). */
  readonly ipAttemptLimit: number;

  constructor(config: ConfigService) {
    this.adminUrl = config.get<string>('ADMIN_URL', 'http://localhost:4300').replace(/\/$/, '');
    this.cookieSecure = config.get<string>('COOKIE_SECURE', 'false') === 'true';
    this.secretBox = new SecretBox(config.getOrThrow<string>('TOTP_ENCRYPTION_KEY'));
    this.ipAttemptLimit = Number(config.get<string>('AUTH_IP_ATTEMPT_LIMIT', '30'));
  }

  /** Origins allowed to send state-changing admin requests (CSRF defence). */
  get allowedOrigins(): string[] {
    return [new URL(this.adminUrl).origin];
  }
}
