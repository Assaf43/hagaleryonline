import { Injectable, Logger } from '@nestjs/common';
import type { CustomerMe, OtpChannel } from '@hg/models';
import { MarketingConsentSource, Prisma, type Customer } from '../generated/prisma/client.js';
import { accountDelayMs } from '../auth/login-throttle.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/passwords.js';
import { maskEmail } from '../notifications/masking.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  emailTaken,
  invalidCode,
  invalidCredentials,
  invalidToken,
  phoneTaken,
  tooManyAttempts,
  wrongPassword,
} from './account-errors.js';
import { CustomerSessionService, type ResolvedCustomer } from './customer-session.service.js';
import { OtpService } from './otp.service.js';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
}

/** Validated sign-up details (normalized phone and e-mail, trimmed name). */
export interface NewCustomer {
  fullName: string;
  phone: string;
  email: string;
  password?: string;
  marketingConsent: boolean;
}

export interface SignedIn {
  customer: CustomerMe;
  /** The new session's cookie value. */
  token: string;
}

export function toMe(c: Customer): CustomerMe {
  return {
    id: c.id,
    fullName: c.fullName,
    phone: c.phone,
    email: c.email,
    phoneVerified: c.phoneVerifiedAt !== null,
    emailVerified: c.emailVerifiedAt !== null,
    hasPassword: c.passwordHash !== null,
    marketingConsent: c.marketingConsent,
  };
}

const FAILURE_MEMORY_MS = 24 * 60 * 60_000;
const MAX_TRACKED = 10_000;

/**
 * Wrong passwords per e-mail, in memory (one API process): the progressive delay of the admin login
 * (`accountDelayMs` after `FREE_FAILURES`). Keyed by the normalized e-mail whether or not an account has it, so an
 * unknown e-mail is delayed exactly like a known one and the delay reveals nothing.
 */
class PasswordFailures {
  private readonly entries = new Map<string, { failures: number; blockedUntil: number; lastAt: number }>();

  waitMs(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.blockedUntil - now) : 0;
  }

  /** Records a failure; returns the new delay (ms). */
  fail(key: string, now = Date.now()): number {
    const entry = this.entries.get(key) ?? { failures: 0, blockedUntil: 0, lastAt: now };
    entry.failures++;
    entry.lastAt = now;
    const delay = accountDelayMs(entry.failures);
    entry.blockedUntil = delay ? now + delay : 0;
    this.entries.set(key, entry);
    if (this.entries.size > MAX_TRACKED) this.prune(now);
    return delay;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }

  private prune(now: number) {
    for (const [key, entry] of this.entries)
      if (now - entry.lastAt > FAILURE_MEMORY_MS && entry.blockedUntil <= now) this.entries.delete(key);
  }
}

/**
 * Customer sign-up and sign-in (spec §6.1, decision 80, NFR-12). Customers are not admins: nothing here goes to the
 * audit log; security events (delays) are logged without codes, tokens or passwords.
 */
@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name);
  private readonly failures = new PasswordFailures();

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: CustomerSessionService,
    private readonly otp: OtpService,
  ) {}

  // ---------- Codes ----------

  /** Always resolves the same way (the caller answers 202) unless the IP is over its limit. */
  requestCode(target: string, channel: OtpChannel, purpose: 'sign_in' | 'sign_up', ip?: string): Promise<void> {
    return this.otp.request(target, channel, purpose, ip);
  }

  /**
   * A sign-in code: signs in the account of that phone or e-mail and marks it verified, or, without an account, gives
   * a sign-up ticket for the verified target.
   */
  async verifySignInCode(
    target: string,
    channel: OtpChannel,
    code: string,
    client: ClientInfo,
  ): Promise<SignedIn | { signUpToken: string }> {
    const row = await this.otp.check(target, 'sign_in', code);
    if (!row) throw invalidCode();
    const customer = await this.prisma.customer.findUnique({
      where: channel === 'email' ? { email: target } : { phone: target },
    });
    if (!customer) return { signUpToken: await this.otp.issueSignUpTicket(row.id) };
    const verified = await this.markVerified(customer, channel);
    return this.signedIn(verified, client);
  }

  // ---------- Sign-up ----------

  /** Without a ticket: nothing is created yet; a code goes to the phone (finished by `verifySignUpCode`). */
  async startSignUp(details: NewCustomer, ip?: string): Promise<void> {
    await this.assertFree(details.phone, details.email);
    await this.otp.request(details.phone, 'sms', 'sign_up', ip);
  }

  /** The code sent by `startSignUp`, with the details sent again: creates the account with the phone verified. */
  async verifySignUpCode(details: NewCustomer, code: string, client: ClientInfo): Promise<SignedIn> {
    await this.assertFree(details.phone, details.email);
    if (!(await this.otp.check(details.phone, 'sign_up', code))) throw invalidCode();
    return this.create(details, 'sms', client);
  }

  /** With a ticket from a verified sign-in code: the ticket's phone or e-mail must be the one signed up. */
  async signUpWithTicket(details: NewCustomer, token: string, client: ClientInfo): Promise<SignedIn> {
    const ticket = await this.otp.peekSignUpTicket(token);
    if (!ticket || ticket.target !== (ticket.channel === 'email' ? details.email : details.phone)) throw invalidToken();
    await this.assertFree(details.phone, details.email);
    if (!(await this.otp.takeSignUpTicket(token))) throw invalidToken();
    return this.create(details, ticket.channel, client);
  }

  // ---------- Password sign-in ----------

  /** One 401 for an unknown e-mail, an account without a password and a wrong password, with the same argon2 cost. */
  async signIn(email: string | null, password: string, client: ClientInfo): Promise<SignedIn> {
    if (!email) {
      await verifyAgainstDummy(password);
      throw invalidCredentials();
    }
    this.assertNotDelayed(email);
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    const ok = customer?.passwordHash
      ? await verifyPassword(customer.passwordHash, password)
      : await verifyAgainstDummy(password);
    if (!customer || !ok) {
      this.registerFailure(email);
      throw invalidCredentials();
    }
    this.failures.reset(email);
    return this.signedIn(customer, client);
  }

  async signOut(sessionId: number): Promise<void> {
    await this.sessions.end(sessionId);
  }

  // ---------- Account changes ----------

  /** Sets or changes the password; a change needs the current one. Every other session is signed out. */
  async changePassword(
    { customer, session }: ResolvedCustomer,
    current: string | undefined,
    next: string,
  ): Promise<CustomerMe> {
    if (customer.passwordHash) {
      this.assertNotDelayed(customer.email);
      if (current === undefined || !(await verifyPassword(customer.passwordHash, current))) {
        this.registerFailure(customer.email);
        throw wrongPassword();
      }
      this.failures.reset(customer.email);
    }
    const updated = await this.prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash: await hashPassword(next) },
    });
    await this.sessions.endAll(customer.id, session.id);
    return toMe(updated);
  }

  /** A code to the new phone or e-mail; nothing changes until it is entered. */
  async requestContactChange(customer: Customer, kind: 'phone' | 'email', value: string, ip?: string): Promise<void> {
    const other = await this.prisma.customer.findFirst({
      where: { [kind]: value, id: { not: customer.id } },
      select: { id: true },
    });
    if (other) throw kind === 'phone' ? phoneTaken() : emailTaken();
    await this.otp.request(value, kind === 'phone' ? 'sms' : 'email', 'verify_contact', ip, {
      customerId: customer.id,
    });
  }

  async confirmContactChange(customer: Customer, kind: 'phone' | 'email', code: string): Promise<CustomerMe> {
    const row = await this.otp.checkForCustomer(customer.id, kind === 'phone' ? 'sms' : 'email', code);
    if (!row) throw invalidCode();
    const now = new Date();
    const data =
      kind === 'phone' ? { phone: row.target, phoneVerifiedAt: now } : { email: row.target, emailVerifiedAt: now };
    try {
      return toMe(await this.prisma.customer.update({ where: { id: customer.id }, data }));
    } catch (error) {
      if (isUniqueViolation(error)) throw kind === 'phone' ? phoneTaken() : emailTaken();
      throw error;
    }
  }

  // ---------- Forgotten password ----------

  /** A code by e-mail when an account has it; the same answer (and the same IP count) when none does. */
  async requestPasswordReset(email: string, ip?: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({ where: { email }, select: { id: true } });
    if (customer) await this.otp.request(email, 'email', 'reset_password', ip);
    else this.otp.checkIp(ip);
  }

  /** Sets the new password, marks the e-mail verified, signs out every session and signs this browser in. */
  async resetPassword(email: string, code: string, next: string, client: ClientInfo): Promise<SignedIn> {
    if (!(await this.otp.check(email, 'reset_password', code))) throw invalidCode();
    const customer = await this.prisma.customer.findUnique({ where: { email } });
    if (!customer) throw invalidCode();
    const updated = await this.prisma.customer.update({
      where: { id: customer.id },
      data: { passwordHash: await hashPassword(next), emailVerifiedAt: customer.emailVerifiedAt ?? new Date() },
    });
    await this.sessions.endAll(customer.id);
    this.failures.reset(email);
    return this.signedIn(updated, client);
  }

  // ---------- Helpers ----------

  private async create(details: NewCustomer, verified: OtpChannel, client: ClientInfo): Promise<SignedIn> {
    const now = new Date();
    try {
      const customer = await this.prisma.customer.create({
        data: {
          fullName: details.fullName,
          phone: details.phone,
          email: details.email,
          passwordHash: details.password ? await hashPassword(details.password) : null,
          phoneVerifiedAt: verified === 'sms' ? now : null,
          emailVerifiedAt: verified === 'email' ? now : null,
          marketingConsent: details.marketingConsent,
          marketingConsentAt: details.marketingConsent ? now : null,
          marketingConsentSource: details.marketingConsent ? MarketingConsentSource.SIGNUP : null,
        },
      });
      return await this.signedIn(customer, client);
    } catch (error) {
      if (isUniqueViolation(error)) await this.assertFree(details.phone, details.email);
      throw error;
    }
  }

  /** 409 `phone_taken` / `email_taken` (sign-up only: accepted by the plan). */
  private async assertFree(phone: string, email: string): Promise<void> {
    const taken = await this.prisma.customer.findMany({
      where: { OR: [{ phone }, { email }] },
      select: { phone: true, email: true },
    });
    if (taken.some((c) => c.phone === phone)) throw phoneTaken();
    if (taken.some((c) => c.email === email)) throw emailTaken();
  }

  private async markVerified(customer: Customer, channel: OtpChannel): Promise<Customer> {
    const field = channel === 'email' ? 'emailVerifiedAt' : 'phoneVerifiedAt';
    if (customer[field]) return customer;
    return this.prisma.customer.update({ where: { id: customer.id }, data: { [field]: new Date() } });
  }

  private async signedIn(customer: Customer, client: ClientInfo): Promise<SignedIn> {
    return { customer: toMe(customer), token: await this.sessions.start(customer.id, client) };
  }

  private assertNotDelayed(email: string): void {
    const waitMs = this.failures.waitMs(email);
    if (waitMs > 0) throw tooManyAttempts(Math.ceil(waitMs / 1000));
  }

  private registerFailure(email: string): void {
    const delay = this.failures.fail(email);
    if (delay) this.logger.warn(`Wrong passwords for ${maskEmail(email)}: next attempt in ${delay / 1000} s`);
  }
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
