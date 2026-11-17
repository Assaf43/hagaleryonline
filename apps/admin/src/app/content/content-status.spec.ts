import { CONTENT_STATUS_LABELS, contentDatesText, contentStatus } from './content-status';

const NOW = Date.parse('2026-11-17T09:00:00.000Z');

describe('contentStatus', () => {
  it('is off when the switch is off, whatever the dates', () => {
    expect(contentStatus({ active: false, startsAt: null, endsAt: null }, NOW)).toBe('off');
    expect(contentStatus({ active: false, startsAt: '2026-11-01T00:00:00.000Z' }, NOW)).toBe('off');
  });

  it('is active without dates, inside the window and at both inclusive edges', () => {
    expect(contentStatus({ active: true }, NOW)).toBe('active');
    expect(
      contentStatus({ active: true, startsAt: '2026-11-01T00:00:00.000Z', endsAt: '2026-12-01T00:00:00.000Z' }, NOW),
    ).toBe('active');
    expect(contentStatus({ active: true, startsAt: '2026-11-17T09:00:00.000Z' }, NOW)).toBe('active');
    expect(contentStatus({ active: true, endsAt: '2026-11-17T09:00:00.000Z' }, NOW)).toBe('active');
  });

  it('is scheduled before the start and ended after the end', () => {
    expect(contentStatus({ active: true, startsAt: '2026-11-17T09:00:00.001Z' }, NOW)).toBe('scheduled');
    expect(contentStatus({ active: true, endsAt: '2026-11-17T08:59:59.999Z' }, NOW)).toBe('ended');
  });

  it('has the Hebrew labels', () => {
    expect(CONTENT_STATUS_LABELS).toEqual({ active: 'פעיל', scheduled: 'מתוזמן', ended: 'הסתיים', off: 'כבוי' });
  });
});

describe('contentDatesText', () => {
  it('reads Israel whole days', () => {
    expect(contentDatesText({ startsAt: '2026-11-30T22:00:00.000Z', endsAt: '2026-12-31T21:59:59.999Z' })).toBe(
      '1.12.2026 – 31.12.2026',
    );
    expect(contentDatesText({ startsAt: null, endsAt: null })).toBe('ללא תאריכים');
  });
});
