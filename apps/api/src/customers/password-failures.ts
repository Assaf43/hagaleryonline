import { accountDelayMs } from '../auth/login-throttle.js';

const DEFAULT_MAX_KEYS = 10_000;

/**
 * Wrong passwords per e-mail, in memory (one API process): the progressive delay of the admin login
 * (`accountDelayMs` after `FREE_FAILURES`). Keyed by the normalized e-mail whether or not an account has it, so an
 * unknown e-mail is delayed exactly like a known one and the delay reveals nothing. At most `maxKeys` keys: the least
 * recently failed key is evicted first, so a flood of e-mails cannot grow it without bound.
 */
export class PasswordFailures {
  /** Insertion order = least recently failed first (a failing key is moved to the end). */
  private readonly entries = new Map<string, { failures: number; blockedUntil: number }>();

  constructor(private readonly maxKeys = DEFAULT_MAX_KEYS) {}

  get size(): number {
    return this.entries.size;
  }

  waitMs(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    return entry ? Math.max(0, entry.blockedUntil - now) : 0;
  }

  /** Records a failure; returns the new delay (ms). */
  fail(key: string, now = Date.now()): number {
    const entry = this.entries.get(key) ?? { failures: 0, blockedUntil: 0 };
    entry.failures++;
    const delay = accountDelayMs(entry.failures);
    entry.blockedUntil = delay ? now + delay : 0;
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > this.maxKeys) this.entries.delete(this.entries.keys().next().value as string);
    return delay;
  }

  reset(key: string): void {
    this.entries.delete(key);
  }
}
