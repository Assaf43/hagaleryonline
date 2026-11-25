import { TestBed } from '@angular/core/testing';
import { DateAdapter, MAT_DATE_FORMATS, MAT_DATE_LOCALE } from '@angular/material/core';
import { IsraelDateAdapter, ISRAEL_DATE_FORMATS } from './israel-date-adapter';

describe('IsraelDateAdapter', () => {
  const adapter = () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: MAT_DATE_LOCALE, useValue: 'he-IL' },
        { provide: DateAdapter, useClass: IsraelDateAdapter },
        { provide: MAT_DATE_FORMATS, useValue: ISRAEL_DATE_FORMATS },
      ],
    });
    return TestBed.inject(DateAdapter) as IsraelDateAdapter;
  };

  it('formats day.month.year with two digits', () => {
    expect(adapter().format(new Date(2026, 11, 3), 'dateInput')).toBe('03.12.2026');
  });

  it('parses d.m.yyyy, d/m/yyyy and d-m-yyyy, day first', () => {
    const a = adapter();
    for (const text of ['3.12.2026', '3/12/2026', '3-12-2026', '03.12.2026']) {
      const d = a.parse(text, 'dateInput')!;
      expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 11, 3]);
    }
  });

  it('refuses a month-first, impossible or incomplete date', () => {
    const a = adapter();
    for (const text of ['12/31/2026', '31.2.2026', '3.12', '3.12.26', 'abc', '0.1.2026']) {
      expect(a.isValid(a.parse(text, 'dateInput') as Date)).toBe(false);
    }
  });

  it('writes the local day into min / max attributes, not the UTC day', () => {
    expect(adapter().toIso8601(new Date(2000, 0, 1))).toBe('2000-01-01');
  });

  it('treats an empty text as no date, and starts the week on Sunday', () => {
    const a = adapter();
    expect(a.parse('  ', 'dateInput')).toBeNull();
    expect(a.getFirstDayOfWeek()).toBe(0);
  });
});
