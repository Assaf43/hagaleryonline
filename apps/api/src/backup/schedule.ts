/** When the backup daemon runs next: `BACKUP_AT` (HH:MM) Israel time, correct across summer-time changes (Intl only). */

export const BACKUP_TIME_ZONE = 'Asia/Jerusalem';

const AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseAt(at: string): { hour: number; minute: number } {
  const match = AT.exec(at);
  if (!match) throw new Error('BACKUP_AT must be HH:MM (24-hour, Israel time)');
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: BACKUP_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

/** The wall-clock fields of an instant in Israel. */
function wallClock(date: Date): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const out: Record<string, number> = {};
  for (const part of parts.formatToParts(date)) if (part.type !== 'literal') out[part.type] = Number(part.value);
  return { year: out.year, month: out.month, day: out.day, hour: out.hour, minute: out.minute, second: out.second };
}

/** Israel's offset from UTC at an instant, in ms (+2 h in winter, +3 h in summer). */
function offsetAt(ms: number): number {
  const w = wallClock(new Date(ms));
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(ms / 1000) * 1000;
}

/**
 * The instant of an Israel wall-clock time. Two passes settle the offset. A time inside the hour skipped in March
 * comes out one hour later (02:30 → 03:30 summer time); a time that happens twice in October comes out once.
 */
function israelTime(year: number, month: number, day: number, hour: number, minute: number): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute);
  const first = asUtc - offsetAt(asUtc);
  return new Date(asUtc - offsetAt(first));
}

/** The first `at` (Israel time) strictly after `now`. */
export function nextRun(now: Date, at: string): Date {
  const { hour, minute } = parseAt(at);
  const today = wallClock(now);
  for (let add = 0; add <= 2; add++) {
    const day = new Date(Date.UTC(today.year, today.month - 1, today.day + add));
    const candidate = israelTime(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), hour, minute);
    if (candidate.getTime() > now.getTime()) return candidate;
  }
  throw new Error('nextRun: no run time found');
}
