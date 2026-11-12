import { backoff, MAX_ATTEMPTS } from './backoff.js';

describe('outbox backoff (spec §5.1)', () => {
  it('waits 30 s after the first failure, then doubles', () => {
    expect(backoff(1)).toBe(30_000);
    expect(backoff(2)).toBe(60_000);
    expect(backoff(3)).toBe(120_000);
  });

  it('is capped at one hour', () => {
    expect(backoff(8)).toBe(3_600_000);
    expect(backoff(20)).toBe(3_600_000);
  });

  it('gives up after 8 attempts', () => {
    expect(MAX_ATTEMPTS).toBe(8);
  });
});
