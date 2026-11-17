import { formatIsraelDate } from '../core/israel-time';

export type ContentStatus = 'active' | 'scheduled' | 'ended' | 'off';

export const CONTENT_STATUS_LABELS: Record<ContentStatus, string> = {
  active: 'פעיל',
  scheduled: 'מתוזמן',
  ended: 'הסתיים',
  off: 'כבוי',
};

/** A row with a switch and an optional date window (an announcement; a page or FAQ group passes `active: published`). */
export interface ContentWindowRow {
  active: boolean;
  startsAt?: string | null;
  endsAt?: string | null;
}

/**
 * The state of a row now: switched off, not started yet, past its end, or live. Both ends are inclusive (the end is
 * stored as 23:59:59.999 of the last Israel day), exactly like the API.
 */
export function contentStatus(row: ContentWindowRow, now = Date.now()): ContentStatus {
  if (!row.active) return 'off';
  if (row.endsAt && now > Date.parse(row.endsAt)) return 'ended';
  if (row.startsAt && now < Date.parse(row.startsAt)) return 'scheduled';
  return 'active';
}

/** "1.12.2026 – 31.12.2026", "מ־1.12.2026", "עד 31.12.2026" or "ללא תאריכים", in Israel time. */
export function contentDatesText(row: Pick<ContentWindowRow, 'startsAt' | 'endsAt'>): string {
  const start = row.startsAt ? formatIsraelDate(row.startsAt, 'start') : null;
  const end = row.endsAt ? formatIsraelDate(row.endsAt, 'end') : null;
  if (start && end) return `${start} – ${end}`;
  if (start) return `מ־${start}`;
  if (end) return `עד ${end}`;
  return 'ללא תאריכים';
}
