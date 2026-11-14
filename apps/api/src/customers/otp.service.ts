import { createHmac, randomInt } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { OtpChannel } from '@hg/models';
import { hashToken, randomToken, safeEqual } from '../auth/crypto.js';
import { maskEmail, maskPhone } from '../notifications/masking.js';
import { tooManyRequests } from './account-errors.js';

export type OtpPurposeCode = 'sign_in' | 'sign_up' | 'verify_contact' | 'reset_password';

/** Spec §6.2: 6 digits, valid 10 minutes, up to 5 attempts; at most 3 codes per target per 10 minutes. */
export const OTP_TTL_MS = 10 * 60_000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_TARGET_LIMIT = 3;
export const OTP_TARGET_WINDOW_MS = 10 * 60_000;
/** The sign-up ticket a verified code for an unknown phone or e-mail gives (single use). */
export const SIGN_UP_TICKET_TTL_MS = 30 * 60_000;
/** The window of the per-IP limit (`THROTTLE_OTP_LIMIT`), for Retry-After. */
const IP_WINDOW_SECONDS = 15 * 60;

export interface OtpRow {
  id: number;
  target: string;
  channel: OtpChannel;
  purpose: OtpPurposeCode;
  codeHash: string;
  expiresAt: Date;
  attempts: number;
  consumedAt: Date | null;
  customerId: string | null;
  createdAt: Date;
}

export interface NewOtp {
  target: string;
  channel: OtpChannel;
  purpose: OtpPurposeCode;
  codeHash: string;
  expiresAt: Date;
  customerId: string | null;
}

/** Where codes live (Prisma in the app, memory in unit tests). Every write is a single conditional statement. */
export interface OtpStore {
  /** Codes created for this target since `since`, whatever the purpose. */
  countSince(target: string, since: Date): Promise<number>;
  /** Ends the live codes of a target and purpose (a new code replaces them). */
  expireLive(target: string, purpose: OtpPurposeCode, now: Date): Promise<void>;
  create(row: NewOtp): Promise<OtpRow>;
  /** The newest code of a target and purpose: only it can be used. */
  latest(target: string, purpose: OtpPurposeCode): Promise<OtpRow | null>;
  /** The newest contact code of a customer on a channel. */
  latestForCustomer(customerId: string, purpose: OtpPurposeCode, channel: OtpChannel): Promise<OtpRow | null>;
  /** attempts + 1 while it is below `max`; false when the code has no attempt left. */
  spendAttempt(id: number, max: number): Promise<boolean>;
  /** Marks the code used; false when it already was. */
  consume(id: number, now: Date): Promise<boolean>;
  setSignUpTicket(id: number, tokenHash: string, expiresAt: Date): Promise<void>;
  findSignUpTicket(tokenHash: string, now: Date): Promise<{ target: string; channel: OtpChannel } | null>;
  /** Clears the ticket; null when it is unknown, used or expired. */
  takeSignUpTicket(tokenHash: string, now: Date): Promise<{ target: string; channel: OtpChannel } | null>;
}

export interface OtpRequestOptions {
  customerId?: string;
  ipChecked?: boolean;
  deliver?: boolean;
  background?: boolean;
}

/** Sends the `otp` template (SMS or e-mail) directly, not through the outbox: the code is useless after 10 minutes. */
export interface OtpSender {
  send(channel: OtpChannel, target: string, code: string): Promise<void>;
}

/** The per-IP limit on code requests (`THROTTLE_OTP_LIMIT` per 15 minutes). */
export interface OtpIpLimiter {
  allow(ip: string | undefined): boolean;
}

/** HMAC-SHA256 (key `OTP_PEPPER`) of code + target + purpose: a leaked table cannot be brute-forced offline. */
export function hashOtp(pepper: string, code: string, target: string, purpose: OtpPurposeCode): string {
  return createHmac('sha256', pepper).update(`${code}:${target}:${purpose}`).digest('hex');
}

/** Only for development and tests: production refuses to start without its own `OTP_PEPPER`. */
const DEV_PEPPER = 'dev-otp-pepper-not-for-production';
const MIN_PEPPER_LENGTH = 32;

/** The HMAC key of the codes: `OTP_PEPPER`, required in production (at least 32 characters). */
export function resolveOtpPepper(value: string | undefined, nodeEnv: string | undefined): string {
  if (nodeEnv !== 'production') return value || DEV_PEPPER;
  if (!value || value.length < MIN_PEPPER_LENGTH)
    throw new Error('OTP_PEPPER is required in production (at least 32 random characters).');
  return value;
}

const CODE_PATTERN = /^\d{6}$/;

/**
 * One-time codes (spec §6.2, NFR-12). A new code ends the earlier ones of the same target and purpose, and only the
 * newest is ever checked. Every check spends an attempt before comparing, so 5 wrong answers kill the code even
 * under concurrent requests. Over the per-target limit the request is silently dropped (the caller still answers 202).
 */
export class OtpService {
  private readonly logger = new Logger(OtpService.name);

  constructor(
    private readonly store: OtpStore,
    private readonly sender: OtpSender,
    private readonly ipLimiter: OtpIpLimiter,
    private readonly pepper: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Counts a code request against the IP; 429 over the limit. Called by `request`, and alone where nothing is sent. */
  checkIp(ip: string | undefined): void {
    if (!this.ipLimiter.allow(ip)) throw tooManyRequests(IP_WINDOW_SECONDS);
  }

  /**
   * Creates and sends a code. Options: `customerId` (contact change), `ipChecked` (the caller already counted the IP,
   * e.g. before a 409 check), `deliver: false` (the same store work without a message: no account to send to),
   * `background` (the send is not awaited; a failure is logged), so the answer time does not depend on the send.
   */
  async request(
    target: string,
    channel: OtpChannel,
    purpose: OtpPurposeCode,
    ip: string | undefined,
    opts: OtpRequestOptions = {},
  ): Promise<void> {
    if (!opts.ipChecked) this.checkIp(ip);
    const now = this.now();
    if ((await this.store.countSince(target, new Date(now - OTP_TARGET_WINDOW_MS))) >= OTP_TARGET_LIMIT) {
      this.logger.warn(`Code limit reached for ${mask(channel, target)}: request dropped`);
      return;
    }
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.store.expireLive(target, purpose, new Date(now));
    await this.store.create({
      target,
      channel,
      purpose,
      codeHash: hashOtp(this.pepper, code, target, purpose),
      expiresAt: new Date(now + OTP_TTL_MS),
      customerId: opts.customerId ?? null,
    });
    if (opts.deliver === false) return;
    if (!opts.background) return this.sender.send(channel, target, code);
    void this.sender
      .send(channel, target, code)
      .catch((error: unknown) =>
        this.logger.error(`Could not send a code to ${mask(channel, target)}: ${(error as Error)?.message ?? error}`),
      );
  }

  async verify(target: string, purpose: OtpPurposeCode, code: string): Promise<boolean> {
    return (await this.check(target, purpose, code)) !== null;
  }

  /** Checks and uses the newest code of the target and purpose; returns its row, or null. */
  async check(target: string, purpose: OtpPurposeCode, code: string): Promise<OtpRow | null> {
    if (!CODE_PATTERN.test(code)) return null;
    return this.use(await this.store.latest(target, purpose), code);
  }

  /** The pending new phone or e-mail of a signed-in customer: checks the code and returns its row (the new value). */
  async checkForCustomer(customerId: string, channel: OtpChannel, code: string): Promise<OtpRow | null> {
    if (!CODE_PATTERN.test(code)) return null;
    return this.use(await this.store.latestForCustomer(customerId, 'verify_contact', channel), code);
  }

  /** A ticket that lets the browser finish sign-up for the verified target of this code (30 minutes, once). */
  async issueSignUpTicket(codeId: number): Promise<string> {
    const token = randomToken();
    await this.store.setSignUpTicket(codeId, hashToken(token), new Date(this.now() + SIGN_UP_TICKET_TTL_MS));
    return token;
  }

  peekSignUpTicket(token: string): Promise<{ target: string; channel: OtpChannel } | null> {
    return this.store.findSignUpTicket(hashToken(token), new Date(this.now()));
  }

  takeSignUpTicket(token: string): Promise<{ target: string; channel: OtpChannel } | null> {
    return this.store.takeSignUpTicket(hashToken(token), new Date(this.now()));
  }

  private async use(row: OtpRow | null, code: string): Promise<OtpRow | null> {
    const now = this.now();
    if (!row || row.consumedAt || row.expiresAt.getTime() <= now) return null;
    if (!(await this.store.spendAttempt(row.id, OTP_MAX_ATTEMPTS))) return null;
    if (!safeEqual(row.codeHash, hashOtp(this.pepper, code, row.target, row.purpose))) return null;
    return (await this.store.consume(row.id, new Date(now))) ? row : null;
  }
}

/** The recipient as the logs may show it. */
export function mask(channel: OtpChannel, target: string): string {
  return channel === 'email' ? maskEmail(target) : maskPhone(target);
}
