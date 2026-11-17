/**
 * Time windows of content rows (Phase 8 §4.1, §6): evaluated per request against the cached rows, never cached
 * themselves. `startsAt` and `endsAt` are both inclusive: the admin stores the end as 23:59:59.999 of the last Israel
 * day, so a row is live at that instant and ended one millisecond later (`now > endsAt`).
 */
export interface Windowed {
  /** Missing = always on (a row kind without an on/off switch). */
  active?: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
}

export function isLive(row: Windowed, now: Date): boolean {
  if (row.active === false) return false;
  if (row.startsAt && now.getTime() < row.startsAt.getTime()) return false;
  if (row.endsAt && now.getTime() > row.endsAt.getTime()) return false;
  return true;
}

/**
 * The one announcement shown now (NAV-04): among the live rows, the lowest `sortOrder`, then the newest `startsAt`
 * (a row without a start counts as the oldest), then the highest id.
 */
export function currentAnnouncement<T extends Windowed & { id: number; sortOrder: number }>(
  rows: readonly T[],
  now: Date,
): T | null {
  let best: T | null = null;
  for (const row of rows) {
    if (!isLive(row, now)) continue;
    if (!best || before(row, best)) best = row;
  }
  return best;
}

/** True when `a` wins over `b`. */
function before(a: Windowed & { id: number; sortOrder: number }, b: Windowed & { id: number; sortOrder: number }) {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder < b.sortOrder;
  const aStart = a.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  const bStart = b.startsAt?.getTime() ?? Number.NEGATIVE_INFINITY;
  if (aStart !== bStart) return aStart > bStart;
  return a.id > b.id;
}
