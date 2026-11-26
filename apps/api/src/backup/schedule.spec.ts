import { nextRun, parseAt } from './schedule.js';

describe('nextRun (Israel time)', () => {
  it('runs today when the time has not come yet (winter, UTC+2)', () => {
    expect(nextRun(new Date('2026-11-26T00:00:00Z'), '02:30').toISOString()).toBe('2026-11-26T00:30:00.000Z');
  });

  it('runs tomorrow when the time has passed (or is now)', () => {
    expect(nextRun(new Date('2026-11-26T00:30:00Z'), '02:30').toISOString()).toBe('2026-11-27T00:30:00.000Z');
    expect(nextRun(new Date('2026-11-26T12:00:00Z'), '02:30').toISOString()).toBe('2026-11-27T00:30:00.000Z');
  });

  it('uses summer time (UTC+3)', () => {
    expect(nextRun(new Date('2026-07-01T12:00:00Z'), '02:30').toISOString()).toBe('2026-07-01T23:30:00.000Z');
  });

  it('March: the day after the change runs at 02:30 summer time', () => {
    // Summer time starts on Friday 2026-03-27 at 02:00 (clocks jump to 03:00).
    expect(nextRun(new Date('2026-03-26T00:00:00Z'), '02:30').toISOString()).toBe('2026-03-26T00:30:00.000Z');
    expect(nextRun(new Date('2026-03-27T12:00:00Z'), '02:30').toISOString()).toBe('2026-03-27T23:30:00.000Z');
  });

  it('March: a time inside the skipped hour runs one hour later that night', () => {
    // 02:30 does not exist on 2026-03-27: it runs at 03:30 summer time (00:30 UTC), once.
    expect(nextRun(new Date('2026-03-26T12:00:00Z'), '02:30').toISOString()).toBe('2026-03-27T00:30:00.000Z');
  });

  it('October: the change night and the nights around it', () => {
    // Summer time ends on Sunday 2026-10-25 at 02:00 (clocks go back to 01:00).
    expect(nextRun(new Date('2026-10-23T12:00:00Z'), '02:30').toISOString()).toBe('2026-10-23T23:30:00.000Z');
    expect(nextRun(new Date('2026-10-24T12:00:00Z'), '02:30').toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(nextRun(new Date('2026-10-25T12:00:00Z'), '02:30').toISOString()).toBe('2026-10-26T00:30:00.000Z');
  });

  it('October: a repeated time runs once', () => {
    // 01:30 happens twice on 2026-10-25 (22:30 and 23:30 UTC on the 24th); the next run after either is the next day.
    const first = nextRun(new Date('2026-10-24T12:00:00Z'), '01:30');
    expect(['2026-10-24T22:30:00.000Z', '2026-10-24T23:30:00.000Z']).toContain(first.toISOString());
    expect(nextRun(first, '01:30').toISOString()).toBe('2026-10-25T23:30:00.000Z');
  });

  it('is always in the future and within about a day', () => {
    for (let t = Date.parse('2026-01-01T00:00:00Z'); t < Date.parse('2027-01-01T00:00:00Z'); t += 3_600_000 * 7) {
      const next = nextRun(new Date(t), '02:30').getTime();
      expect(next).toBeGreaterThan(t);
      expect(next - t).toBeLessThanOrEqual(25 * 3_600_000);
    }
  });
});

describe('parseAt', () => {
  it('accepts HH:MM, 24-hour', () => {
    expect(parseAt('02:30')).toEqual({ hour: 2, minute: 30 });
    expect(parseAt('23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it.each(['2:30', '24:00', '02:60', '0230', '', ' 02:30', '02:30:00'])('refuses %j', (value) => {
    expect(() => parseAt(value)).toThrow('BACKUP_AT must be HH:MM');
  });
});
