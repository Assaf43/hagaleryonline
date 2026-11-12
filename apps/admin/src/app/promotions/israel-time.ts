/**
 * Promotion dates are entered and shown in Israel time (Asia/Jerusalem, with daylight saving) and stored in UTC.
 * A date without a time means the whole day: a start at 00:00, an end at 23:59:59.999 of that day.
 */

const ZONE = 'Asia/Jerusalem';
const WALL = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});
const DAY_END = { hour: 23, minute: 59, second: 59, ms: 999 };

interface Wall {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The wall clock in Israel at a UTC instant (whole seconds). */
function wallAt(utcMs: number): Wall {
  const parts = WALL.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** Israel's offset from UTC at an instant, in ms (+2 h in winter, +3 h in summer). */
function offsetAt(utcMs: number): number {
  const w = wallAt(utcMs);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(utcMs / 1000) * 1000;
}

/** Israel wall-clock time → UTC ms. The offset is checked at the result, so DST days come out right. */
function israelToUtc(date: string, hour: number, minute: number, second = 0, ms = 0): number {
  const [y, m, d] = date.split('-').map(Number);
  const asUtc = Date.UTC(y, m - 1, d, hour, minute, second, ms);
  const first = asUtc - offsetAt(asUtc);
  return asUtc - offsetAt(first);
}

const hm = (time: string) => time.split(':').map(Number) as [number, number];

/** "2026-03-27" (+ optional "09:30") in Israel → ISO UTC; no time = 00:00. */
export function israelStartToUtc(date: string, time: string): string {
  const [h, m] = time ? hm(time) : [0, 0];
  return new Date(israelToUtc(date, h, m)).toISOString();
}

/** "2026-03-27" (+ optional "18:00") in Israel → ISO UTC; no time = the end of that day (23:59:59.999). */
export function israelEndToUtc(date: string, time: string): string {
  if (time) {
    const [h, m] = hm(time);
    return new Date(israelToUtc(date, h, m)).toISOString();
  }
  return new Date(israelToUtc(date, DAY_END.hour, DAY_END.minute, DAY_END.second, DAY_END.ms)).toISOString();
}

const pad = (n: number) => String(n).padStart(2, '0');

function fields(iso: string): { date: string; time: string; wall: Wall; ms: number } {
  const utc = new Date(iso).getTime();
  const wall = wallAt(utc);
  return {
    date: `${wall.year}-${pad(wall.month)}-${pad(wall.day)}`,
    time: `${pad(wall.hour)}:${pad(wall.minute)}`,
    wall,
    ms: ((utc % 1000) + 1000) % 1000,
  };
}

const isDayStart = (f: { wall: Wall; ms: number }) =>
  f.wall.hour === 0 && f.wall.minute === 0 && f.wall.second === 0 && f.ms === 0;
const isDayEnd = (f: { wall: Wall; ms: number }) =>
  f.wall.hour === DAY_END.hour &&
  f.wall.minute === DAY_END.minute &&
  f.wall.second === DAY_END.second &&
  f.ms === DAY_END.ms;

/** The form fields of a stored start: date and time in Israel; no time when it is the start of the day. */
export function startFields(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const f = fields(iso);
  return { date: f.date, time: isDayStart(f) ? '' : f.time };
}

/** The form fields of a stored end; no time when it is the end of the day. */
export function endFields(iso: string | null): { date: string; time: string } {
  if (!iso) return { date: '', time: '' };
  const f = fields(iso);
  return { date: f.date, time: isDayEnd(f) ? '' : f.time };
}

/** "1.12.2026", or "1.7.2026 18:00" when the time is not the day's edge. */
export function formatIsraelDate(iso: string, edge: 'start' | 'end'): string {
  const f = fields(iso);
  const date = `${f.wall.day}.${f.wall.month}.${f.wall.year}`;
  const whole = edge === 'start' ? isDayStart(f) : isDayEnd(f);
  return whole ? date : `${date} ${f.time}`;
}

/**
 * The Israel calendar date of an instant, "6.11.2026". Angular's `date` pipe takes only offsets ('+0200'), not
 * 'Asia/Jerusalem', so it would show the browser's (or a CI runner's) local date.
 */
export function israelDay(iso: string): string {
  const { wall } = fields(iso);
  return `${wall.day}.${wall.month}.${wall.year}`;
}

/** The Israel-time month (YYYY-MM) of an instant: what "this month" means on the invoices page. */
export function israelMonthOf(at: Date): string {
  const f = fields(at.toISOString());
  return f.date.slice(0, 7);
}

/** YYYY-MM moved by whole months (negative = earlier). */
export function shiftMonth(month: string, delta: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + delta;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}
