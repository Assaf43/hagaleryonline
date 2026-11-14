import type { OtpChannel } from '@hg/models';
import { NotificationChannel, OtpPurpose, type OtpCode } from '../generated/prisma/client.js';
import type { PrismaService } from '../prisma/prisma.service.js';
import type { NewOtp, OtpPurposeCode, OtpRow, OtpStore } from './otp.service.js';

const PURPOSES: Record<OtpPurposeCode, OtpPurpose> = {
  sign_in: OtpPurpose.SIGN_IN,
  sign_up: OtpPurpose.SIGN_UP,
  verify_contact: OtpPurpose.VERIFY_CONTACT,
  reset_password: OtpPurpose.RESET_PASSWORD,
};
const PURPOSE_CODES = Object.fromEntries(Object.entries(PURPOSES).map(([k, v]) => [v, k])) as Record<
  OtpPurpose,
  OtpPurposeCode
>;

const channelOf = (channel: OtpChannel) => (channel === 'email' ? NotificationChannel.EMAIL : NotificationChannel.SMS);
const channelCode = (channel: NotificationChannel): OtpChannel =>
  channel === NotificationChannel.EMAIL ? 'email' : 'sms';

function toRow(r: OtpCode): OtpRow {
  return {
    id: r.id,
    target: r.target,
    channel: channelCode(r.channel),
    purpose: PURPOSE_CODES[r.purpose],
    codeHash: r.codeHash,
    expiresAt: r.expiresAt,
    attempts: r.attempts,
    consumedAt: r.consumedAt,
    customerId: r.customerId,
    createdAt: r.createdAt,
  };
}

/** `OtpStore` on the `otp_codes` table; attempts, use and tickets are conditional single-row updates. */
export class PrismaOtpStore implements OtpStore {
  constructor(private readonly prisma: PrismaService) {}

  countSince(target: string, since: Date): Promise<number> {
    return this.prisma.otpCode.count({ where: { target, createdAt: { gt: since } } });
  }

  async expireLive(target: string, purpose: OtpPurposeCode, now: Date): Promise<void> {
    await this.prisma.otpCode.updateMany({
      where: { target, purpose: PURPOSES[purpose], consumedAt: null, expiresAt: { gt: now } },
      data: { expiresAt: now },
    });
  }

  async create(row: NewOtp): Promise<OtpRow> {
    const created = await this.prisma.otpCode.create({
      data: { ...row, channel: channelOf(row.channel), purpose: PURPOSES[row.purpose] },
    });
    return toRow(created);
  }

  async latest(target: string, purpose: OtpPurposeCode): Promise<OtpRow | null> {
    const row = await this.prisma.otpCode.findFirst({
      where: { target, purpose: PURPOSES[purpose] },
      orderBy: { id: 'desc' },
    });
    return row ? toRow(row) : null;
  }

  async latestForCustomer(customerId: string, purpose: OtpPurposeCode, channel: OtpChannel): Promise<OtpRow | null> {
    const row = await this.prisma.otpCode.findFirst({
      where: { customerId, purpose: PURPOSES[purpose], channel: channelOf(channel) },
      orderBy: { id: 'desc' },
    });
    return row ? toRow(row) : null;
  }

  async spendAttempt(id: number, max: number): Promise<boolean> {
    const { count } = await this.prisma.otpCode.updateMany({
      where: { id, attempts: { lt: max } },
      data: { attempts: { increment: 1 } },
    });
    return count === 1;
  }

  async consume(id: number, now: Date): Promise<boolean> {
    const { count } = await this.prisma.otpCode.updateMany({
      where: { id, consumedAt: null },
      data: { consumedAt: now },
    });
    return count === 1;
  }

  async setSignUpTicket(id: number, tokenHash: string, expiresAt: Date): Promise<void> {
    await this.prisma.otpCode.update({
      where: { id },
      data: { signUpTokenHash: tokenHash, signUpExpiresAt: expiresAt },
    });
  }

  async findSignUpTicket(tokenHash: string, now: Date): Promise<{ target: string; channel: OtpChannel } | null> {
    const row = await this.prisma.otpCode.findFirst({
      where: { signUpTokenHash: tokenHash, signUpExpiresAt: { gt: now } },
    });
    return row ? { target: row.target, channel: channelCode(row.channel) } : null;
  }

  async takeSignUpTicket(tokenHash: string, now: Date): Promise<{ target: string; channel: OtpChannel } | null> {
    const row = await this.findSignUpTicket(tokenHash, now);
    if (!row) return null;
    const { count } = await this.prisma.otpCode.updateMany({
      where: { signUpTokenHash: tokenHash, signUpExpiresAt: { gt: now } },
      data: { signUpTokenHash: null },
    });
    return count === 1 ? row : null;
  }
}
