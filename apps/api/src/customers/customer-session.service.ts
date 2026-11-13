import { Injectable } from '@nestjs/common';
import type { Customer, CustomerSession } from '../generated/prisma/client.js';
import { hashToken, randomToken } from '../auth/crypto.js';
import { PrismaService } from '../prisma/prisma.service.js';

export const CUSTOMER_COOKIE = 'hg_customer';
/** Spec §6.2: 30 days, renewed on use. */
export const CUSTOMER_SESSION_MS = 30 * 24 * 60 * 60_000;
/** The expiry and the cookie are renewed at most once a day. */
const RENEW_EVERY_MS = 24 * 60 * 60_000;

export interface ResolvedCustomer {
  session: CustomerSession;
  customer: Customer;
  /** The expiry moved: the caller sends the cookie again. */
  renewed: boolean;
}

/**
 * Storefront sessions (spec §6.2), like the admin `SessionService`: a random token in the `hg_customer` cookie, only
 * its SHA-256 in `customer_sessions`. Sliding 30 days; sign-out deletes the row.
 */
@Injectable()
export class CustomerSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Starts a session; returns the cookie value. */
  async start(customerId: string, meta: { ip?: string; userAgent?: string } = {}): Promise<string> {
    const token = randomToken();
    await this.prisma.customerSession.create({
      data: {
        customerId,
        tokenHash: hashToken(token),
        expiresAt: new Date(Date.now() + CUSTOMER_SESSION_MS),
        ip: meta.ip?.slice(0, 64),
        userAgent: meta.userAgent?.slice(0, 256),
      },
    });
    return token;
  }

  /** The live session behind a cookie, or null (unknown, expired); renews it when the last renewal is a day old. */
  async resolve(token: string | undefined, now = new Date()): Promise<ResolvedCustomer | null> {
    if (!token || token.length > 128) return null;
    const found = await this.prisma.customerSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { customer: true },
    });
    if (!found || found.expiresAt <= now) return null;
    const { customer, ...session } = found;
    if (now.getTime() - session.lastSeenAt.getTime() < RENEW_EVERY_MS) return { session, customer, renewed: false };

    const expiresAt = new Date(now.getTime() + CUSTOMER_SESSION_MS);
    await this.prisma.customerSession.updateMany({
      where: { id: session.id },
      data: { lastSeenAt: now, expiresAt },
    });
    return { session: { ...session, lastSeenAt: now, expiresAt }, customer, renewed: true };
  }

  async end(sessionId: number): Promise<void> {
    await this.prisma.customerSession.deleteMany({ where: { id: sessionId } });
  }

  /** Signs the customer out everywhere, optionally keeping one session (password change). */
  async endAll(customerId: string, exceptSessionId?: number): Promise<void> {
    await this.prisma.customerSession.deleteMany({
      where: { customerId, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
    });
  }
}
