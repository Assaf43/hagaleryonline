import { backoff, MAX_ATTEMPTS } from './backoff.js';

describe('outbox backoff (spec §5.1: 8 attempts over several hours)', () => {
  it('waits 5 minutes after the first failure, then doubles', () => {
    expect(backoff(1)).toBe(300_000);
    expect(backoff(2)).toBe(600_000);
    expect(backoff(3)).toBe(1_200_000);
    expect(backoff(4)).toBe(2_400_000);
  });

  it('is capped at one hour', () => {
    expect(backoff(5)).toBe(3_600_000);
    expect(backoff(8)).toBe(3_600_000);
    expect(backoff(20)).toBe(3_600_000);
  });

  it('gives up after 8 attempts, about 4 hours after the first', () => {
    expect(MAX_ATTEMPTS).toBe(8);
    let total = 0;
    for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt++) total += backoff(attempt);
    expect(total).toBe(255 * 60_000);
  });
});
