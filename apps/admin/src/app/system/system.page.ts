import { ChangeDetectionStrategy, Component, DOCUMENT, DestroyRef, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import type {
  BackupRunView,
  ErrorGroupDetail,
  ErrorGroupPage,
  ErrorGroupState,
  ErrorGroupView,
  SystemStatus,
} from '@hg/models';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';
import { israelDateTime } from '../core/israel-time';
import { ConfirmDialog, type ConfirmDialogData } from '../orders/confirm-dialog';
import { SystemApi } from './system.api';

const REFRESH_MS = 60_000;
/**
 * Auto-refresh stops after this long without a real input: every answered admin call counts as activity, so a
 * page left open would otherwise keep the session alive past the 8-hour idle logout (decision 53).
 */
export const IDLE_STOP_MS = 30 * 60_000;
/** What a person does on the page; a poll's own answer is none of these. */
const INPUT_EVENTS = ['pointerdown', 'keydown', 'touchstart', 'focusin', 'wheel'] as const;
const GB = 1024 ** 3;
/** Below this percent free (as shown, rounded) the disk card warns. */
const LOW_DISK_PERCENT = 10;

const FILTERS: { value: ErrorGroupState; label: string }[] = [
  { value: 'open', label: 'פתוחות' },
  { value: 'handled', label: 'טופלו' },
  { value: 'all', label: 'הכול' },
];
const EMPTY: Record<ErrorGroupState, string> = {
  open: 'אין תקלות פתוחות',
  handled: 'אין תקלות שטופלו',
  all: 'אין תקלות',
};
const SOURCES = { api: 'שרת', ssr: 'אתר' } as const;

type RunState = 'ok' | 'failed' | 'running' | 'never';

/** One backup card line: what happened, when, and a short size. */
interface RunLine {
  label: string;
  state: RunState;
  stateLabel: string;
  when: string | null;
  size: string | null;
  detail: string | null;
}

const RUN_LABELS: Record<RunState, string> = {
  ok: 'הצליח',
  failed: 'נכשל',
  running: 'בתהליך',
  never: 'עוד לא בוצע',
};

/** "dd.mm.yyyy hh:mm" in Israel time. */
export function padDateTime(iso: string): string {
  const [date, time] = israelDateTime(iso).split(' ');
  const [d, m, y] = date.split('.');
  const [h, min] = time.split(':');
  return `${d.padStart(2, '0')}.${m.padStart(2, '0')}.${y} ${h.padStart(2, '0')}:${min.padStart(2, '0')}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function runLine(label: string, run: BackupRunView | null): RunLine {
  if (!run) return { label, state: 'never', stateLabel: RUN_LABELS.never, when: null, size: null, detail: null };
  const state: RunState = run.ok === true ? 'ok' : run.ok === false ? 'failed' : 'running';
  const parts = [
    run.bytes !== null ? formatBytes(run.bytes) : null,
    run.objects !== null ? `${run.objects} קבצים` : null,
  ].filter((p): p is string => p !== null);
  return {
    label,
    state,
    stateLabel: RUN_LABELS[state],
    when: padDateTime(run.finishedAt ?? run.startedAt),
    size: parts.length ? parts.join(' · ') : null,
    detail: state === 'failed' ? run.detail : null,
  };
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : `${n} ${many}`);

/** "3 ימים, 4 שעות", "4 שעות, 12 דקות" or "12 דקות". */
export function formatUptime(seconds: number): string {
  const minutes = Math.floor(seconds / 60) % 60;
  const hours = Math.floor(seconds / 3600) % 24;
  const days = Math.floor(seconds / 86_400);
  const d = plural(days, 'יום אחד', 'ימים');
  const h = plural(hours, 'שעה אחת', 'שעות');
  const m = plural(minutes, 'דקה אחת', 'דקות');
  if (days > 0) return `${d}, ${h}`;
  if (hours > 0) return `${h}, ${m}`;
  return m;
}

/**
 * "תקלות ומצב המערכת" (spec 9b.6, permission system.view): status cards and the error groups the API and the
 * storefront server collected. Refreshes itself every minute while the tab is visible, and stops after 30 minutes
 * without input (pointer, keyboard, touch, focus) until the next input or "רענון". A row opens in place to its
 * stack; "סימון כטופל" asks first, and a group that comes back opens again by itself.
 */
@Component({
  selector: 'hga-system-page',
  imports: [RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './system.page.html',
  styleUrl: './system.page.scss',
})
export class SystemPage {
  private readonly api = inject(SystemApi);
  private readonly dialog = inject(MatDialog);
  protected readonly auth = inject(AuthService);

  protected readonly filters = FILTERS;
  protected readonly sources = SOURCES;
  protected readonly status = signal<SystemStatus | null>(null);
  protected readonly statusError = signal('');
  protected readonly state = signal<ErrorGroupState>('open');
  protected readonly page = signal(1);
  protected readonly groups = signal<ErrorGroupPage | null>(null);
  protected readonly groupsError = signal('');
  protected readonly loading = signal(false);
  protected readonly openId = signal<number | null>(null);
  protected readonly detail = signal<ErrorGroupDetail | null>(null);
  protected readonly detailError = signal('');
  protected readonly marking = signal(false);
  /** Auto-refresh stopped for lack of input. */
  protected readonly paused = signal(false);

  protected readonly canOpenJobs = computed(() => this.auth.can('orders.manage'));
  protected readonly emptyText = computed(() => EMPTY[this.state()]);
  protected readonly pageCount = computed(() => {
    const g = this.groups();
    return g ? Math.max(1, Math.ceil(g.total / g.pageSize)) : 1;
  });

  protected readonly disk = computed(() => {
    const s = this.status();
    if (!s || s.diskFreeBytes === null || s.diskTotalBytes === null || s.diskTotalBytes <= 0) return null;
    const percent = Math.round((s.diskFreeBytes / s.diskTotalBytes) * 100);
    return {
      free: (s.diskFreeBytes / GB).toFixed(1),
      total: (s.diskTotalBytes / GB).toFixed(1),
      percent,
      low: percent < LOW_DISK_PERCENT,
    };
  });
  protected readonly backups = computed<RunLine[]>(() => {
    const s = this.status();
    return s ? [runLine('מסד נתונים', s.lastBackup.db), runLine('תמונות', s.lastBackup.media)] : [];
  });
  protected readonly restore = computed(() => {
    const s = this.status();
    return s ? runLine('', s.lastRestoreTest) : null;
  });
  protected readonly uptime = computed(() => {
    const s = this.status();
    return s ? formatUptime(s.uptimeSeconds) : '';
  });

  /** Increases with every list request; an older, slower answer is dropped. */
  private seq = 0;
  /** When the person last used the page (not when a poll answered). */
  private lastInput = Date.now();

  constructor() {
    void this.loadStatus();
    void this.loadGroups();
    const doc = inject(DOCUMENT);
    const onInput = () => this.noteInput();
    for (const type of INPUT_EVENTS) doc.addEventListener(type, onInput, { capture: true, passive: true });
    const timer = setInterval(() => this.tick(doc), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      for (const type of INPUT_EVENTS) doc.removeEventListener(type, onInput, { capture: true });
    });
  }

  protected when(iso: string): string {
    return padDateTime(iso);
  }

  protected reload() {
    this.refresh();
  }

  /** "רענון" after the pause: one refresh now, and auto-refresh again. */
  protected resume() {
    this.noteInput();
    this.paused.set(false);
    this.refresh();
  }

  /**
   * Only remembers the time: the next tick resumes. Hiding the pause line here would remove the "רענון" button
   * between its pointerdown and its click.
   */
  private noteInput() {
    this.lastInput = Date.now();
  }

  private tick(doc: Document) {
    if (doc.visibilityState !== 'visible') return;
    const idle = Date.now() - this.lastInput >= IDLE_STOP_MS;
    this.paused.set(idle);
    if (!idle) this.refresh();
  }

  protected choose(state: ErrorGroupState) {
    if (state === this.state()) return;
    this.state.set(state);
    this.page.set(1);
    this.collapse();
    void this.loadGroups();
  }

  protected go(page: number) {
    this.page.set(page);
    this.collapse();
    void this.loadGroups();
  }

  protected toggle(group: ErrorGroupView) {
    if (this.openId() === group.id) return this.collapse();
    this.openId.set(group.id);
    this.detail.set(null);
    this.detailError.set('');
    void this.loadDetail(group.id);
  }

  protected markHandled(group: ErrorGroupView) {
    this.dialog
      .open<ConfirmDialog, ConfirmDialogData, boolean>(ConfirmDialog, {
        data: { message: 'לסמן את התקלה כטופלה? אם היא תחזור, היא תיפתח שוב.' },
        width: '28rem',
        maxWidth: '95vw',
      })
      .afterClosed()
      .subscribe((yes) => {
        if (yes === true) void this.runHandled(group.id);
      });
  }

  private async runHandled(id: number) {
    this.marking.set(true);
    this.detailError.set('');
    try {
      await this.api.markHandled(id);
      this.collapse();
      await this.loadGroups();
    } catch (e) {
      this.detailError.set(errorMessage(e));
    } finally {
      this.marking.set(false);
    }
  }

  private collapse() {
    this.openId.set(null);
    this.detail.set(null);
    this.detailError.set('');
  }

  private refresh() {
    void this.loadStatus();
    void this.loadGroups();
    const id = this.openId();
    if (id !== null) void this.loadDetail(id);
  }

  private async loadStatus() {
    try {
      this.status.set(await this.api.status());
      this.statusError.set('');
    } catch (e) {
      this.statusError.set(errorMessage(e));
    }
  }

  private async loadGroups() {
    const mine = ++this.seq;
    this.loading.set(true);
    try {
      const result = await this.api.errors(this.state(), this.page());
      if (mine !== this.seq) return;
      this.groups.set(result);
      this.groupsError.set('');
    } catch (e) {
      if (mine === this.seq) this.groupsError.set(errorMessage(e));
    } finally {
      if (mine === this.seq) this.loading.set(false);
    }
  }

  private async loadDetail(id: number) {
    try {
      const d = await this.api.error(id);
      if (this.openId() === id) this.detail.set(d);
    } catch (e) {
      if (this.openId() === id) this.detailError.set(errorMessage(e));
    }
  }
}
