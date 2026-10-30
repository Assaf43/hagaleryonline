import { Injectable } from '@nestjs/common';
import { AdminUserStatus, type AdminSession, type AdminUser } from '../generated/prisma/client.js';
import { PrismaService } from '../prisma/prisma.service.js';
import { PENDING_SESSION_MS, SESSION_IDLE_MS, SESSION_MAX_MS, TRUSTED_SESSION_MS } from './auth.config.js';
import { hashToken, randomToken } from './crypto.js';

/** Don't write last_seen_at on every request. */
const TOUCH_EVERY_MS = 60_000;

export interface ResolvedSession {
  session: AdminSession;
  user: AdminUser;
}

/**
 * Server-side sessions (decision 53): 8 h idle timeout, at most 7 days; a "remember this device"
 * session has no idle timeout and lasts 30 days. A session waiting for 2FA lives 10 minutes.
 */
@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Starts a session after a correct password. Returns the cookie value. */
  async start(userId: number, opts: { mfaVerified: boolean; trusted: boolean; ip?: string; userAgent?: string }) {
    const token = randomToken();
    const now = Date.now();
    await this.prisma.adminSession.create({
      data: {
        userId,
        tokenHash: hashToken(token),
        mfaVerified: opts.mfaVerified,
        trusted: opts.trusted,
        expiresAt: new Date(now + (opts.mfaVerified ? maxAge(opts.trusted) : PENDING_SESSION_MS)),
        ip: opts.ip?.slice(0, 64),
        userAgent: opts.userAgent?.slice(0, 256),
      },
    });
    return token;
  }

  /** The live session behind a cookie, or null when it is unknown, revoked, expired, idle or the user is disabled. */
  async resolve(token: string | undefined, now = new Date()): Promise<ResolvedSession | null> {
    if (!token) return null;
    const session = await this.prisma.adminSession.findUnique({
      where: { tokenHash: hashToken(token) },
      include: { user: true },
    });
    if (!session || session.revokedAt || session.expiresAt <= now) return null;
    if (session.mfaVerified && !session.trusted && now.getTime() - session.lastSeenAt.getTime() > SESSION_IDLE_MS)
      return null;
    if (session.user.status !== AdminUserStatus.ACTIVE) return null;

    if (now.getTime() - session.lastSeenAt.getTime() > TOUCH_EVERY_MS) {
      await this.prisma.adminSession.update({ where: { id: session.id }, data: { lastSeenAt: now } });
    }
    const { user, ...rest } = session;
    return { session: rest, user };
  }

  /** 2FA passed: the pending session becomes a full one. */
  async completeMfa(sessionId: number, trusted: boolean) {
    await this.prisma.adminSession.update({
      where: { id: sessionId },
      data: { mfaVerified: true, lastSeenAt: new Date(), expiresAt: new Date(Date.now() + maxAge(trusted)) },
    });
  }

  async revoke(sessionId: number) {
    await this.prisma.adminSession.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
  }

  /** Logs the user out everywhere, optionally keeping the current session. */
  async revokeAll(userId: number, exceptSessionId?: number) {
    await this.prisma.adminSession.updateMany({
      where: { userId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      data: { revokedAt: new Date() },
    });
  }
}

function maxAge(trusted: boolean): number {
  return trusted ? TRUSTED_SESSION_MS : SESSION_MAX_MS;
}
