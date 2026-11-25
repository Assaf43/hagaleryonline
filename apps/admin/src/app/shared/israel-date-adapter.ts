import { Injectable } from '@angular/core';
import { NativeDateAdapter } from '@angular/material/core';

/** Passed as the display format by `ISRAEL_DATE_FORMATS`: the input text, always day.month.year. */
const INPUT_FORMAT = 'dateInput';

const TYPED = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Dates in the admin read day.month.year whatever the browser's language is: "03.12.2026". Typing accepts
 * d.m.yyyy, d/m/yyyy and d-m-yyyy, always day first ("12/31/2026" is not a date). Weeks start on Sunday and the
 * month and day names are Hebrew.
 */
@Injectable()
export class IsraelDateAdapter extends NativeDateAdapter {
  override format(date: Date, displayFormat: object | string): string {
    if (displayFormat !== INPUT_FORMAT) return super.format(date, displayFormat as object);
    if (!this.isValid(date)) throw Error('IsraelDateAdapter: Cannot format invalid date.');
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
  }

  override parse(value: unknown, _parseFormat?: unknown): Date | null {
    if (typeof value !== 'string') return value == null || value === '' ? null : this.invalid();
    const text = value.trim();
    if (!text) return null;
    const m = TYPED.exec(text);
    if (!m) return this.invalid();
    const [day, month, year] = [Number(m[1]), Number(m[2]), Number(m[3])];
    // Built directly: createDate throws for a day the month does not have, and typed text may be anything.
    if (year < 1900) return this.invalid();
    const date = new Date(year, month - 1, day);
    return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day
      ? date
      : this.invalid();
  }

  /** Material builds the `min` / `max` attributes from the UTC fields, which is the day before in Israel. */
  override toIso8601(date: Date): string {
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  }

  override getFirstDayOfWeek(): number {
    return 0;
  }
}

export const ISRAEL_DATE_FORMATS = {
  parse: { dateInput: INPUT_FORMAT },
  display: {
    dateInput: INPUT_FORMAT,
    monthYearLabel: { year: 'numeric', month: 'short' },
    dateA11yLabel: { year: 'numeric', month: 'long', day: 'numeric' },
    monthYearA11yLabel: { year: 'numeric', month: 'long' },
  },
};
