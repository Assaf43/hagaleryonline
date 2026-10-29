/**
 * Brute-force protection (NFR-12, decision 59).
 *
 * Per account: after 5 failures the next attempt must wait 30 s, doubling up to 15 min. There is no
 * hard lock-out, so nobody can lock a colleague out on purpose.
 * Per IP: at most 30 password or code attempts per 15 minutes, against spraying many accounts.
 */
export const FREE_FAILURES = 5;
const BASE_DELAY_MS = 30_000;
const MAX_DELAY_MS = 15 * 60_000;

export function accountDelayMs(failures: number): number {
  if (failures < FREE_FAILURES) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (failures - FREE_FAILURES), MAX_DELAY_MS);
}

export class IpThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit = 30,
    private readonly windowMs = 15 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Records an attempt; returns false when the IP is over the limit. */
  allow(ip: string): boolean {
    const now = this.now();
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < this.windowMs);
    if (recent.length >= this.limit) {
      this.hits.set(ip, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return true;
  }

  private prune(now: number) {
    for (const [ip, times] of this.hits) {
      if (times.every((t) => now - t >= this.windowMs)) this.hits.delete(ip);
    }
  }
}
