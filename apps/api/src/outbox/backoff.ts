/** Attempts before a job is FAILED (spec §5.1: 8 attempts over several hours). */
export const MAX_ATTEMPTS = 8;

const FIRST_DELAY_MS = 300_000;
const MAX_DELAY_MS = 3_600_000;

/**
 * Milliseconds to wait after failed attempt number `attempt` (1-based): 5, 10, 20, 40 minutes, then one hour — the 8
 * attempts span about 4 hours (review ruling).
 */
export function backoff(attempt: number): number {
  return Math.min(FIRST_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS);
}
