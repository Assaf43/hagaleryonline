import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';

const CLEANUP_EVERY_MS = 24 * 60 * 60_000;
/** One-time codes are kept this long past their expiry (and past their sign-up ticket's), then deleted. */
export const OTP_RETENTION_MS = 24 * 60 * 60_000;

/**
 * Retention of customer sign-in data (NFR-12, privacy): once a day, like the cart cleanup (`CartService`), deletes
 * expired `customer_sessions` and the `otp_codes` a day past their expiry. Codes hold plain phones and e-mails, also
 * of people who never made an account. A code row also carries its sign-up ticket (30 minutes, set within the code's
 * 10 minutes), so a row is kept while its ticket is less than a day past expiry too; the per-target request limit
 * looks back 10 minutes only. Nothing else reads an expired code or session.
 */
@Injectable()
export class CustomerCleanupService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CustomerCleanupService.name);
  private cleanupTimer: NodeJS.Timeout | undefined;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit(): void {
    const cleanup = () =>
      this.deleteExpired().catch((error: unknown) =>
        this.logger.error('Customer session and code cleanup failed', error),
      );
    void cleanup();
    this.cleanupTimer = setInterval(() => void cleanup(), CLEANUP_EVERY_MS).unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.cleanupTimer);
  }

  /** Deletes sessions past their expiry and codes (with their tickets) a day past theirs; returns the counts. */
  async deleteExpired(now = new Date()): Promise<{ sessions: number; codes: number }> {
    const sessions = await this.prisma.customerSession.deleteMany({ where: { expiresAt: { lt: now } } });
    const before = new Date(now.getTime() - OTP_RETENTION_MS);
    const codes = await this.prisma.otpCode.deleteMany({
      where: {
        expiresAt: { lt: before },
        OR: [{ signUpExpiresAt: null }, { signUpExpiresAt: { lt: before } }],
      },
    });
    return { sessions: sessions.count, codes: codes.count };
  }
}
