import type { DeliverySlotInput, DeliverySlotView } from '@hg/models';
import { DeliverySlotState } from '../generated/prisma/client.js';
import { fieldError } from './order-errors.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const SLOT_NOTE_MAX = 500;

const SLOT_STATE_VIEW: Record<DeliverySlotState, DeliverySlotView['state']> = {
  PROPOSED: 'proposed',
  CONFIRMED: 'confirmed',
  CHANGE_REQUESTED: 'change_requested',
  SUPERSEDED: 'superseded',
};

/** Today's calendar date in Israel, YYYY-MM-DD (spec §4.1: slot dates are Israel-time dates). */
export function israelToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jerusalem' }).format(now);
}

/** A real calendar date written YYYY-MM-DD. */
function isCalendarDate(value: string): boolean {
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The request's slot, checked: 400 `slot.date` (missing, malformed, in the past) or `slot.window` (times, order). */
export function parseSlot(raw: unknown, now = new Date()): DeliverySlotInput {
  const dateError = () => fieldError('slot.date', 'יש לבחור תאריך אספקה (היום או מאוחר יותר)');
  const windowError = () => fieldError('slot.window', 'יש להזין חלון שעות תקין (HH:MM), שעת ההתחלה לפני שעת הסיום');
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw dateError();
  const { date, windowFrom, windowTo, note } = raw as Record<string, unknown>;
  if (typeof date !== 'string' || !isCalendarDate(date) || date < israelToday(now)) throw dateError();
  if (typeof windowFrom !== 'string' || !TIME_PATTERN.test(windowFrom)) throw windowError();
  if (typeof windowTo !== 'string' || !TIME_PATTERN.test(windowTo) || windowFrom >= windowTo) throw windowError();
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > SLOT_NOTE_MAX))
    throw fieldError('slot.note', 'ההערה ארוכה מדי (עד 500 תווים)');
  const trimmed = typeof note === 'string' ? note.trim() : '';
  return { date, windowFrom, windowTo, ...(trimmed ? { note: trimmed } : {}) };
}

/** The slot an order shows: its one non-superseded slot. */
export function currentSlotView(
  slots: { date: Date; windowFrom: string; windowTo: string; state: DeliverySlotState }[],
): DeliverySlotView | null {
  const live = slots.find((s) => s.state !== DeliverySlotState.SUPERSEDED);
  return live
    ? {
        date: live.date.toISOString().slice(0, 10),
        windowFrom: live.windowFrom,
        windowTo: live.windowTo,
        state: SLOT_STATE_VIEW[live.state],
      }
    : null;
}
