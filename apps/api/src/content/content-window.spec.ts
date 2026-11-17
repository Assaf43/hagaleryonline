import { currentAnnouncement, isLive } from './content-window.js';

describe('window and version', () => {
  // 31.12.2026 in Israel (UTC+2 in winter): the last day ends at 21:59:59.999 UTC.
  const startsAt = new Date('2026-11-30T22:00:00.000Z');
  const endsAt = new Date('2026-12-31T21:59:59.999Z');
  const row = { active: true, startsAt, endsAt };

  it('is not live before the start, live at the start instant', () => {
    expect(isLive(row, new Date(startsAt.getTime() - 1))).toBe(false);
    expect(isLive(row, startsAt)).toBe(true);
  });

  it('is live at the stored end instant (23:59:59.999 Israel time) and ended one millisecond later', () => {
    expect(isLive(row, new Date('2026-12-31T21:59:00.000Z'))).toBe(true);
    expect(isLive(row, endsAt)).toBe(true);
    expect(isLive(row, new Date(endsAt.getTime() + 1))).toBe(false);
    expect(isLive(row, new Date('2026-12-31T22:00:00.000Z'))).toBe(false);
  });

  it('open dates are always live; a row turned off never is; a row without a switch counts as on', () => {
    const now = new Date('2030-01-01T00:00:00.000Z');
    expect(isLive({ active: true, startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isLive({ active: false, startsAt: null, endsAt: null }, now)).toBe(false);
    expect(isLive({ startsAt: null, endsAt: null }, now)).toBe(true);
    expect(isLive({ startsAt: null, endsAt }, now)).toBe(false);
  });

  describe('currentAnnouncement', () => {
    const now = new Date('2026-12-15T10:00:00.000Z');
    const a = (
      id: number,
      over: Partial<{ active: boolean; sortOrder: number; startsAt: Date | null; endsAt: Date | null }> = {},
    ) => ({
      id,
      active: true,
      sortOrder: 0,
      startsAt: null as Date | null,
      endsAt: null as Date | null,
      ...over,
    });

    it('returns null when nothing is live', () => {
      expect(currentAnnouncement([], now)).toBeNull();
      expect(
        currentAnnouncement([a(1, { active: false }), a(2, { startsAt: new Date('2027-01-01') })], now),
      ).toBeNull();
    });

    it('takes the lowest sortOrder first', () => {
      expect(
        currentAnnouncement([a(1, { sortOrder: 2 }), a(2, { sortOrder: 1 }), a(3, { sortOrder: 3 })], now)?.id,
      ).toBe(2);
    });

    it('then the newest start (no start counts as the oldest), then the highest id', () => {
      const older = a(1, { startsAt: new Date('2026-12-01') });
      const newer = a(2, { startsAt: new Date('2026-12-10') });
      const noStart = a(3);
      expect(currentAnnouncement([older, noStart, newer], now)?.id).toBe(2);
      expect(currentAnnouncement([older, noStart], now)?.id).toBe(1);
      expect(currentAnnouncement([a(4), a(7), a(5)], now)?.id).toBe(7);
    });

    it('skips rows that are off, not started or ended even when they would win', () => {
      const rows = [
        a(1, { sortOrder: 0, active: false }),
        a(2, { sortOrder: 0, endsAt: new Date('2026-12-14T21:59:59.999Z') }),
        a(3, { sortOrder: 0, startsAt: new Date('2026-12-16') }),
        a(4, { sortOrder: 5 }),
      ];
      expect(currentAnnouncement(rows, now)?.id).toBe(4);
    });
  });
});
