import type { OtpChannel } from '@hg/models';
import type { NewOtp, OtpPurposeCode, OtpRow, OtpStore } from '../src/customers/otp.service.js';

type Row = OtpRow & { signUpTokenHash: string | null; signUpExpiresAt: Date | null };

/** In-memory `OtpStore` for unit tests: the same semantics as the Prisma store. */
export class MemoryOtpStore implements OtpStore {
  readonly rows: Row[] = [];
  private nextId = 1;

  constructor(private readonly now: () => number) {}

  countSince(target: string, since: Date): Promise<number> {
    return Promise.resolve(this.rows.filter((r) => r.target === target && r.createdAt > since).length);
  }

  expireLive(target: string, purpose: OtpPurposeCode, now: Date): Promise<void> {
    for (const r of this.rows)
      if (r.target === target && r.purpose === purpose && !r.consumedAt && r.expiresAt > now) r.expiresAt = now;
    return Promise.resolve();
  }

  create(row: NewOtp): Promise<OtpRow> {
    const created: Row = {
      ...row,
      id: this.nextId++,
      attempts: 0,
      consumedAt: null,
      createdAt: new Date(this.now()),
      signUpTokenHash: null,
      signUpExpiresAt: null,
    };
    this.rows.push(created);
    return Promise.resolve({ ...created });
  }

  latest(target: string, purpose: OtpPurposeCode): Promise<OtpRow | null> {
    return this.newest((r) => r.target === target && r.purpose === purpose);
  }

  latestForCustomer(customerId: string, purpose: OtpPurposeCode, channel: OtpChannel): Promise<OtpRow | null> {
    return this.newest((r) => r.customerId === customerId && r.purpose === purpose && r.channel === channel);
  }

  spendAttempt(id: number, max: number): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.attempts >= max) return Promise.resolve(false);
    row.attempts++;
    return Promise.resolve(true);
  }

  consume(id: number, now: Date): Promise<boolean> {
    const row = this.rows.find((r) => r.id === id);
    if (!row || row.consumedAt) return Promise.resolve(false);
    row.consumedAt = now;
    return Promise.resolve(true);
  }

  setSignUpTicket(id: number, tokenHash: string, expiresAt: Date): Promise<void> {
    const row = this.rows.find((r) => r.id === id)!;
    row.signUpTokenHash = tokenHash;
    row.signUpExpiresAt = expiresAt;
    return Promise.resolve();
  }

  findSignUpTicket(tokenHash: string, now: Date): Promise<{ target: string; channel: OtpChannel } | null> {
    const row = this.ticket(tokenHash, now);
    return Promise.resolve(row ? { target: row.target, channel: row.channel } : null);
  }

  takeSignUpTicket(tokenHash: string, now: Date): Promise<{ target: string; channel: OtpChannel } | null> {
    const row = this.ticket(tokenHash, now);
    if (!row) return Promise.resolve(null);
    row.signUpTokenHash = null;
    return Promise.resolve({ target: row.target, channel: row.channel });
  }

  private ticket(tokenHash: string, now: Date): Row | undefined {
    return this.rows.find((r) => r.signUpTokenHash === tokenHash && r.signUpExpiresAt! > now);
  }

  private newest(match: (r: Row) => boolean): Promise<OtpRow | null> {
    const row = this.rows.filter(match).at(-1);
    return Promise.resolve(row ? { ...row } : null);
  }
}
