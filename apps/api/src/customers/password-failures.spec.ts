import { FREE_FAILURES } from '../auth/login-throttle.js';
import { PasswordFailures } from './password-failures.js';

describe('PasswordFailures (NFR-12)', () => {
  it('delays a key after the free failures and resets it', () => {
    const failures = new PasswordFailures();
    const now = 1_000_000;
    for (let i = 1; i < FREE_FAILURES; i++) expect(failures.fail('a', now)).toBe(0);
    expect(failures.fail('a', now)).toBeGreaterThan(0);
    expect(failures.waitMs('a', now)).toBeGreaterThan(0);
    failures.reset('a');
    expect(failures.waitMs('a', now)).toBe(0);
  });

  it('never keeps more than its cap, evicting the oldest key', () => {
    const failures = new PasswordFailures(3);
    for (let i = 0; i < FREE_FAILURES; i++) failures.fail('old', 0);
    for (const key of ['b', 'c', 'd']) failures.fail(key, 0);
    expect(failures.size).toBe(3);
    expect(failures.waitMs('old', 0)).toBe(0);
  });

  it('a key touched again becomes the newest', () => {
    const failures = new PasswordFailures(2);
    for (let i = 0; i < FREE_FAILURES; i++) failures.fail('a', 0);
    failures.fail('b', 0);
    failures.fail('a', 0);
    failures.fail('c', 0);
    expect(failures.waitMs('a', 0)).toBeGreaterThan(0);
    expect(failures.size).toBe(2);
  });
});
