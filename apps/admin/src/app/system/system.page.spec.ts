import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import type { BackupRunView, ErrorGroupDetail, ErrorGroupPage, ErrorGroupView, SystemStatus } from '@hg/models';
import { AuthService } from '../core/auth.service';
import { ConfirmDialog } from '../orders/confirm-dialog';
import { SystemPage } from './system.page';

const run = (over: Partial<BackupRunView> = {}): BackupRunView => ({
  kind: 'db',
  startedAt: '2026-11-25T01:00:00.000Z',
  finishedAt: '2026-11-25T01:05:00.000Z',
  ok: true,
  bytes: 5 * 1024 * 1024,
  objects: null,
  detail: null,
  ...over,
});

const STATUS: SystemStatus = {
  db: 'up',
  diskFreeBytes: 50 * 1024 ** 3,
  diskTotalBytes: 100 * 1024 ** 3,
  failedJobs: 3,
  lastBackup: { db: run(), media: run({ kind: 'media', objects: 120 }) },
  lastRestoreTest: run({ kind: 'restore_test' }),
  restoreTestStale: false,
  version: 'abc1234',
  uptimeSeconds: 3 * 86_400 + 4 * 3600 + 120,
};

const GROUP = (over: Partial<ErrorGroupView> = {}): ErrorGroupView => ({
  id: 1,
  kind: 'error',
  source: 'api',
  message: 'boom',
  path: '/api/orders',
  count: 7,
  firstSeen: '2026-11-20T08:00:00.000Z',
  lastSeen: '2026-11-25T08:05:00.000Z',
  handledAt: null,
  reopenedAt: null,
  ...over,
});
const PAGE = (items: ErrorGroupView[]): ErrorGroupPage => ({ items, total: items.length, page: 1, pageSize: 20 });
const DETAIL: ErrorGroupDetail = { ...GROUP(), stack: 'Error: boom\n at x', handledBy: null };

const settle = async (fixture: ComponentFixture<unknown>) => {
  await fixture.whenStable();
  fixture.detectChanges();
};

describe('SystemPage ("תקלות ומצב המערכת")', () => {
  let http: HttpTestingController;
  const perms = signal<string[]>(['system.view', 'orders.manage']);

  beforeEach(() => {
    perms.set(['system.view', 'orders.manage']);
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: AuthService, useValue: { can: (p: string) => perms().includes(p) } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => {
    http.verify();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function open(status: SystemStatus = STATUS, groups: ErrorGroupView[] = [GROUP()]) {
    const fixture = TestBed.createComponent(SystemPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/system/status').flush(status);
    http.expectOne((r) => r.url === '/api/admin/system/errors').flush(PAGE(groups));
    await settle(fixture);
    return { fixture, el: fixture.nativeElement as HTMLElement };
  }
  const card = (el: HTMLElement, name: string) =>
    [...el.querySelectorAll<HTMLElement>('.card')].find((c) => c.querySelector('h2')?.textContent?.trim() === name)!;

  it('shows the healthy status', async () => {
    const { el } = await open();
    expect(card(el, 'מסד הנתונים').textContent).toContain('פעיל');
    const disk = card(el, 'מקום פנוי בדיסק');
    expect(disk.textContent).toContain('50.0');
    expect(disk.textContent).toContain('50%');
    const amounts = Array.from(disk.querySelectorAll('bdi[dir="ltr"]')).map((b) => b.textContent?.trim());
    expect(amounts).toEqual(['50.0 GB', '100.0 GB', '50%']);
    expect(card(el, 'גיבוי אחרון').querySelector('bdi[dir="ltr"].run-size')?.textContent).toMatch(/MB$/);
    expect(disk.classList.contains('warn')).toBe(false);
    const jobs = card(el, 'משימות שנכשלו');
    expect(jobs.textContent).toContain('3');
    expect(jobs.querySelector('a')?.getAttribute('href')).toBe('/settings/failed-jobs');
    const backup = card(el, 'גיבוי אחרון');
    expect(backup.textContent).toContain('הצליח');
    expect(backup.textContent).toMatch(/25\.11\.2026 0[34]:05/);
    expect(card(el, 'גרסה').querySelector('bdi')?.getAttribute('dir')).toBe('ltr');
    expect(card(el, 'זמן פעולה').textContent).toContain('3 ימים, 4 שעות');
    expect(el.querySelector('.stale')).toBeNull();
  });

  it('shows the database down, low disk, and no link without orders.manage', async () => {
    perms.set(['system.view']);
    const { el } = await open({ ...STATUS, db: 'down', diskFreeBytes: 5 * 1024 ** 3 });
    expect(card(el, 'מסד הנתונים').textContent).toContain('לא זמין');
    expect(card(el, 'מקום פנוי בדיסק').classList.contains('warn')).toBe(true);
    expect(card(el, 'מקום פנוי בדיסק').textContent).toContain('מעט מקום פנוי');
    expect(card(el, 'משימות שנכשלו').querySelector('a')).toBeNull();
  });

  it('says the disk is unknown when the server cannot read it', async () => {
    const { el } = await open({ ...STATUS, diskFreeBytes: null, diskTotalBytes: null });
    expect(card(el, 'מקום פנוי בדיסק').textContent).toContain('לא ידוע');
  });

  it('shows a failed backup, a backup never run and a restore test in progress', async () => {
    const { el } = await open({
      ...STATUS,
      lastBackup: { db: run({ ok: false, detail: 'pg_dump failed' }), media: null },
      lastRestoreTest: run({ kind: 'restore_test', finishedAt: null, ok: null }),
    });
    const backup = card(el, 'גיבוי אחרון').textContent!;
    expect(backup).toContain('נכשל');
    expect(backup).toContain('pg_dump failed');
    expect(backup).toContain('עוד לא בוצע');
    expect(card(el, 'בדיקת שחזור אחרונה').textContent).toContain('בתהליך');
  });

  it('warns when the restore test is stale', async () => {
    const { el } = await open({ ...STATUS, restoreTestStale: true });
    expect(el.querySelector('.stale')?.textContent).toContain('לא בוצעה בדיקת שחזור ב-35 הימים האחרונים');
    expect(el.querySelector('.stale')?.getAttribute('role')).toBe('alert');
  });

  it('lists error groups with source, path, count and the reopened badge', async () => {
    const { el } = await open(STATUS, [
      GROUP(),
      GROUP({ id: 2, source: 'ssr', path: null, reopenedAt: '2026-11-25T09:00:00.000Z', kind: 'warn' }),
    ]);
    const rows = [...el.querySelectorAll('tbody tr.group')];
    expect(rows).toHaveLength(2);
    expect(rows[0].textContent).toContain('שרת');
    expect(rows[0].textContent).toContain('/api/orders');
    expect(rows[0].textContent).toContain('7');
    expect(rows[0].textContent).toMatch(/20\.11\.2026 (09|10):00/);
    expect(rows[0].querySelector('.reopened')).toBeNull();
    expect(rows[1].textContent).toContain('אתר');
    expect(rows[1].querySelector('.reopened')?.textContent).toContain('חזרה');
    expect(rows[1].textContent).toContain('אזהרה');
    expect([...el.querySelectorAll('thead th')].map((t) => t.textContent?.trim())).toEqual([
      'הודעה',
      'מקור',
      'כתובת',
      'מספר פעמים',
      'נראתה לראשונה',
      'נראתה לאחרונה',
    ]);
  });

  it('says when nothing is open', async () => {
    const { el } = await open(STATUS, []);
    expect(el.querySelector('.empty')?.textContent).toContain('אין תקלות פתוחות');
  });

  it('the filter asks the API with the chosen state', async () => {
    const { fixture, el } = await open();
    const buttons = [...el.querySelectorAll<HTMLButtonElement>('.filters button')];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(['פתוחות', 'טופלו', 'הכול']);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    buttons[1].click();
    const req = http.expectOne((r) => r.url === '/api/admin/system/errors');
    expect(req.request.params.get('state')).toBe('handled');
    expect(req.request.params.get('page')).toBe('1');
    req.flush(PAGE([]));
    await settle(fixture);
    expect(el.querySelector('.empty')?.textContent).toContain('אין תקלות שטופלו');
    expect(el.querySelectorAll<HTMLButtonElement>('.filters button')[1].getAttribute('aria-pressed')).toBe('true');
  });

  it('opens a group to its stack and marks it handled only after the question, then refreshes', async () => {
    const { fixture, el } = await open();
    el.querySelector<HTMLButtonElement>('tr.group button.toggle')!.click();
    http.expectOne('/api/admin/system/errors/1').flush(DETAIL);
    await settle(fixture);
    const pre = el.querySelector('pre')!;
    expect(pre.getAttribute('dir')).toBe('ltr');
    expect(pre.textContent).toContain('Error: boom');

    const dialog = vi
      .spyOn(TestBed.inject(MatDialog), 'open')
      .mockReturnValue({ afterClosed: () => of(false) } as never);
    el.querySelector<HTMLButtonElement>('button.mark-handled')!.click();
    expect(dialog.mock.calls[0][0]).toBe(ConfirmDialog);
    expect(dialog.mock.calls[0][1]?.data).toEqual({
      message: 'לסמן את התקלה כטופלה? אם היא תחזור, היא תיפתח שוב.',
    });
    http.expectNone('/api/admin/system/errors/1/handled');

    dialog.mockReturnValue({ afterClosed: () => of(true) } as never);
    el.querySelector<HTMLButtonElement>('button.mark-handled')!.click();
    http
      .expectOne({ method: 'POST', url: '/api/admin/system/errors/1/handled' })
      .flush(null, { status: 204, statusText: 'No Content' });
    await fixture.whenStable();
    http.expectOne((r) => r.url === '/api/admin/system/errors').flush(PAGE([]));
    await settle(fixture);
    expect(el.querySelector('.empty')).not.toBeNull();
  });

  it('refreshes every 60 s only while the tab is visible', async () => {
    vi.useFakeTimers();
    const fixture = TestBed.createComponent(SystemPage);
    fixture.detectChanges();
    http.expectOne('/api/admin/system/status').flush(STATUS);
    http.expectOne((r) => r.url === '/api/admin/system/errors').flush(PAGE([]));
    await vi.advanceTimersByTimeAsync(0);

    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    http.expectNone('/api/admin/system/status');

    visibility.mockReturnValue('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    http.expectOne('/api/admin/system/status').flush(STATUS);
    http.expectOne((r) => r.url === '/api/admin/system/errors').flush(PAGE([]));
    fixture.destroy();
    await vi.advanceTimersByTimeAsync(120_000);
    http.expectNone('/api/admin/system/status');
  });

  it('stops auto-refresh after 30 minutes without input; input or "רענון" resumes it (decision 53)', async () => {
    vi.useFakeTimers();
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    const fixture = TestBed.createComponent(SystemPage);
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    /** Answers every pending status and list request; returns how many status polls there were. */
    const answer = () => {
      const polls = http.match('/api/admin/system/status');
      for (const r of polls) r.flush(STATUS);
      for (const r of http.match((r) => r.url === '/api/admin/system/errors')) r.flush(PAGE([]));
      return polls.length;
    };
    /** Polls during the next `minutes` minutes, one minute at a time. */
    const pollsIn = async (minutes: number) => {
      let polls = 0;
      for (let i = 0; i < minutes; i++) {
        await vi.advanceTimersByTimeAsync(60_000);
        polls += answer();
      }
      return polls;
    };
    expect(answer()).toBe(1);
    await vi.advanceTimersByTimeAsync(0);

    // A poll every minute while the last input is under 30 minutes old, then none.
    expect(await pollsIn(29)).toBe(29);
    expect(await pollsIn(15)).toBe(0);
    fixture.detectChanges();
    expect(el.querySelector('.paused')?.textContent).toContain('הרענון האוטומטי הופסק כי לא הייתה פעילות.');

    // Input: the next tick polls again and the line goes.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
    expect(await pollsIn(1)).toBe(1);
    fixture.detectChanges();
    expect(el.querySelector('.paused')).toBeNull();

    // Idle again 30 minutes after the input; "רענון" refreshes at once and auto-refresh goes on.
    expect(await pollsIn(28)).toBe(28);
    expect(await pollsIn(5)).toBe(0);
    fixture.detectChanges();
    const button = [...el.querySelectorAll<HTMLButtonElement>('.paused button')].find(
      (b) => b.textContent?.trim() === 'רענון',
    )!;
    button.click();
    expect(answer()).toBe(1);
    fixture.detectChanges();
    expect(el.querySelector('.paused')).toBeNull();
    expect(await pollsIn(2)).toBe(2);
    fixture.destroy();
  });

  it('warns about the disk from the rounded percent it shows', async () => {
    const at = async (freeShare: number) => {
      const { fixture, el } = await open({ ...STATUS, diskFreeBytes: freeShare * 100 * 1024 ** 3 });
      const disk = card(el, 'מקום פנוי בדיסק');
      const result = { text: disk.textContent ?? '', warn: disk.classList.contains('warn') };
      fixture.destroy();
      return result;
    };
    const near = await at(0.096);
    expect(near.text).toContain('10%');
    expect(near.warn).toBe(false);
    const low = await at(0.094);
    expect(low.text).toContain('9%');
    expect(low.warn).toBe(true);
  });
});
