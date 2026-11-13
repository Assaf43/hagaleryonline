import { Injectable, Logger } from '@nestjs/common';
import type { CustomerMe, OtpChannel } from '@hg/models';
import { MarketingConsentSource, Prisma, type Customer } from '../generated/prisma/client.js';
import { hashPassword, verifyAgainstDummy, verifyPassword } from '../auth/passwords.js';
import { CartService } from '../cart/cart.service.js';
import { maskEmail } from '../notifications/masking.js';
import { PrismaService } from '../prisma/prisma.service.js';
import {
  emailTaken,
  invalidCode,
  invalidCredentials,
  invalidToken,
  notVerified,
  phoneTaken,
  tooManyAttempts,
  wrongPassword,
} from './account-errors.js';
import { CustomerSessionService, type ResolvedCustomer } from './customer-session.service.js';
import { OtpService } from './otp.service.js';
import { PasswordFailures } from './password-failures.js';

export interface ClientInfo {
  ip?: string;
  userAgent?: string;
  /** The `hg_customer` cookie the request came with: a new sign-in ends that session first. */
  previousToken?: string;
  /** The `hg_cart` cookie the request came with: its guest cart merges into the account's cart (spec §6.4). */
  cartToken?: string;
}

/** What a sign-up ticket covers: the verified phone and e-mail (normalized), null where no code was entered yet. */
export interface TicketCoverage {
  phone: string | null;
  email: string | null;
}

interface Ticket extends TicketCoverage {
  parts: { token: string; channel: OtpChannel }[];
}

/** A ticket is one or two random tokens joined by '.', each naming one verified contact (an OtpCode row). */
const TICKET_SEPARATOR = '.';
const TICKET_PART_MAX = 64;

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
    private readonly cart: CartService,
  ) {}

  // ---------- Codes ----------

  /** Always resolves the same way (the caller answers 202) unless the IP is over its limit. */
  requestCode(target: string, channel: OtpChannel, purpose: 'sign_in' | 'sign_up', ip?: string): Promise<void> {
    return this.otp.request(target, channel, purpose, ip);
  }

  /**
   * Checks a code. Purpose `sign_in`: signs in the account of that phone or e-mail (and marks it verified). Otherwise
   * (no account, or purpose `sign_up`) answers a sign-up ticket for the verified contact; with `signUpToken` the
   * earlier ticket is extended, so one ticket can cover both the phone and the e-mail (decision 80).
   */
  async verifyCode(
    target: string,
    channel: OtpChannel,
    purpose: 'sign_in' | 'sign_up',
    code: string,
    signUpToken: string | undefined,
    client: ClientInfo,
  ): Promise<SignedIn | { signUpToken: string; verified: TicketCoverage }> {
    // A bad ticket is refused before the code is checked, so it does not spend an attempt.
    const earlier = signUpToken === undefined ? undefined : await this.readTicket(signUpToken);
    const row = await this.otp.check(target, purpose, code);
    if (!row) throw invalidCode();
    if (purpose === 'sign_in') {
      const customer = await this.prisma.customer.findUnique({
        where: channel === 'email' ? { email: target } : { phone: target },
      });
      if (customer) return this.signedIn(await this.markVerified(customer, channel), client);
    }
    const part = await this.otp.issueSignUpTicket(row.id);
    const parts = [...(earlier?.parts.filter((p) => p.channel !== channel) ?? []), { token: part, channel }];
    const verified: TicketCoverage = {
      phone: channel === 'sms' ? target : (earlier?.phone ?? null),
      email: channel === 'email' ? target : (earlier?.email ?? null),
    };
    return { signUpToken: parts.map((p) => p.token).join(TICKET_SEPARATOR), verified };
  }

  // ---------- Sign-up ----------

  /**
   * Without a ticket: nothing is created; a code goes to the phone and one to the e-mail. The IP is counted before the
   * 409 check, so the check is no unthrottled oracle.
   */
  async startSignUp(details: NewCustomer, ip?: string): Promise<void> {
    this.otp.checkIp(ip);
    await this.assertFree(details.phone, details.email);
    await this.otp.request(details.phone, 'sms', 'sign_up', ip, { ipChecked: true });
    await this.otp.request(details.email, 'email', 'sign_up', ip, { ipChecked: true });
  }

  /** With a ticket that covers both the phone and the e-mail sent: creates the account with both verified. */
  async signUpWithTicket(details: NewCustomer, token: string, client: ClientInfo): Promise<SignedIn> {
    this.otp.checkIp(client.ip);
    const ticket = await this.readTicket(token);
    if (ticket.phone !== details.phone) throw notVerified('phone');
    if (ticket.email !== details.email) throw notVerified('email');
    await this.assertFree(details.phone, details.email);
    for (const part of ticket.parts) if (!(await this.otp.takeSignUpTicket(part.token))) throw invalidToken();
    return this.create(details, client);
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
    this.otp.checkIp(ip);
    const other = await this.prisma.customer.findFirst({
      where: { [kind]: value, id: { not: customer.id } },
      select: { id: true },
    });
    if (other) throw kind === 'phone' ? phoneTaken() : emailTaken();
    await this.otp.request(value, kind === 'phone' ? 'sms' : 'email', 'verify_contact', ip, {
      customerId: customer.id,
      ipChecked: true,
    });
  }

  /** Saves the new phone or e-mail as verified and signs out every other session. */
  async confirmContactChange(
    { customer, session }: ResolvedCustomer,
    kind: 'phone' | 'email',
    code: string,
  ): Promise<CustomerMe> {
    const row = await this.otp.checkForCustomer(customer.id, kind === 'phone' ? 'sms' : 'email', code);
    if (!row) throw invalidCode();
    const now = new Date();
    const data =
      kind === 'phone' ? { phone: row.target, phoneVerifiedAt: now } : { email: row.target, emailVerifiedAt: now };
    let updated: Customer;
    try {
      updated = await this.prisma.customer.update({ where: { id: customer.id }, data });
    } catch (error) {
      if (isUniqueViolation(error)) throw kind === 'phone' ? phoneTaken() : emailTaken();
      throw error;
    }
    await this.sessions.endAll(customer.id, session.id);
    return toMe(updated);
  }

  // ---------- Forgotten password ----------

  /**
   * The same work whether or not an account has the e-mail (IP count, target limit, a stored code); the e-mail is sent
   * only to an account, in the background, so neither the answer nor its time tells them apart.
   */
  async requestPasswordReset(email: string, ip?: string): Promise<void> {
    const customer = await this.prisma.customer.findUnique({ where: { email }, select: { id: true } });
    await this.otp.request(email, 'email', 'reset_password', ip, { deliver: customer !== null, background: true });
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

  /** Both contacts were verified by the ticket (decision 80). */
  private async create(details: NewCustomer, client: ClientInfo): Promise<SignedIn> {
    const now = new Date();
    try {
      const customer = await this.prisma.customer.create({
        data: {
          fullName: details.fullName,
          phone: details.phone,
          email: details.email,
          passwordHash: details.password ? await hashPassword(details.password) : null,
          phoneVerifiedAt: now,
          emailVerifiedAt: now,
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

  /**
   * Every sign-in ends here (password, code, sign-up, reset): the cart merge (spec §6.4) first, then the previous
   * session of this browser ends and the new one starts — a merge that fails changes no session.
   */
  private async signedIn(customer: Customer, client: ClientInfo): Promise<SignedIn> {
    await this.cart.attachToCustomer(client.cartToken, customer.id);
    await this.sessions.endByToken(client.previousToken);
    const token = await this.sessions.start(customer.id, { ip: client.ip, userAgent: client.userAgent });
    return { customer: toMe(customer), token };
  }

  /** Reads every part of a ticket (each a live, unused token of one contact); 400 `invalid_token` otherwise. */
  private async readTicket(token: string): Promise<Ticket> {
    const parts = token.split(TICKET_SEPARATOR);
    if (parts.length > 2 || parts.some((p) => p.length === 0 || p.length > TICKET_PART_MAX)) throw invalidToken();
    const ticket: Ticket = { phone: null, email: null, parts: [] };
    for (const part of parts) {
      const found = await this.otp.peekSignUpTicket(part);
      if (!found || ticket.parts.some((p) => p.channel === found.channel)) throw invalidToken();
      if (found.channel === 'email') ticket.email = found.target;
      else ticket.phone = found.target;
      ticket.parts.push({ token: part, channel: found.channel });
    }
    return ticket;
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
