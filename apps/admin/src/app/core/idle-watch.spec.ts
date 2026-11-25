import { TestBed } from '@angular/core/testing';
import { MatDialog } from '@angular/material/dialog';
import { Router, provideRouter } from '@angular/router';
import { Subject } from 'rxjs';
import { ADMIN_SESSION_TOUCH_MS } from '@hg/models';
import { AuthService } from './auth.service';
import { ACTIVITY_KEY, IDLE_WARNING_MS, IdleWatch } from './idle-watch';

const IDLE = 8 * 60 * 60_000;
const T0 = Date.UTC(2026, 10, 25, 8, 0, 0);
const EXPIRY = IDLE - ADMIN_SESSION_TOUCH_MS;
const WARNING = EXPIRY - IDLE_WARNING_MS;

describe('IdleWatch', () => {
  let watch: IdleWatch;
  let closed: Subject<void>;
  const open = vi.fn();
  const close = vi.fn();
  const logout = vi.fn();
  const clear = vi.fn();
  let navigate: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    localStorage.clear();
    closed = new Subject<void>();
    open.mockReset().mockImplementation(() => ({ close, afterClosed: () => closed }));
    close.mockReset().mockImplementation(() => closed.next());
    logout.mockReset().mockResolvedValue(undefined);
    clear.mockReset();
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: MatDialog, useValue: { open } },
        { provide: AuthService, useValue: { logout, clear } },
      ],
    });
    navigate = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    watch = TestBed.inject(IdleWatch);
  });

  afterEach(() => {
    watch.stop();
    vi.useRealTimers();
    localStorage.clear();
  });

  it('warns five minutes before the server cut-off, allowing for its touch interval, and expires then', async () => {
    watch.noteActivity(T0);
    watch.start(IDLE);
    await vi.advanceTimersByTimeAsync(WARNING - 1);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(IDLE_WARNING_MS - 1);
    expect(logout).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(close).toHaveBeenCalled();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(navigate).toHaveBeenCalledWith('/login?reason=idle');
    // The client gives up a touch interval before the server would.
    expect(Date.now() - T0).toBe(IDLE - ADMIN_SESSION_TOUCH_MS);
  });

  it('forgets the user and still leaves when the logout call fails', async () => {
    logout.mockRejectedValue(new Error('offline'));
    watch.noteActivity(T0);
    watch.start(IDLE);
    await vi.advanceTimersByTimeAsync(EXPIRY);
    expect(clear).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/login?reason=idle');
  });

  it('activity in another tab postpones the warning', async () => {
    watch.noteActivity(T0);
    watch.start(IDLE);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const later = Date.now();
    window.dispatchEvent(new StorageEvent('storage', { key: ACTIVITY_KEY, newValue: String(later) }));

    await vi.advanceTimersByTimeAsync(WARNING - 1);
    expect(open).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('closes an open warning when another tab reports activity', async () => {
    watch.noteActivity(T0);
    watch.start(IDLE);
    await vi.advanceTimersByTimeAsync(WARNING);
    expect(open).toHaveBeenCalledTimes(1);

    window.dispatchEvent(new StorageEvent('storage', { key: ACTIVITY_KEY, newValue: String(Date.now()) }));
    expect(close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(IDLE_WARNING_MS + 1000);
    expect(logout).not.toHaveBeenCalled();
  });

  it('ignores other storage keys and older activity', async () => {
    watch.noteActivity(T0);
    watch.start(IDLE);
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: String(T0 + IDLE) }));
    window.dispatchEvent(new StorageEvent('storage', { key: ACTIVITY_KEY, newValue: String(T0 - 1000) }));
    await vi.advanceTimersByTimeAsync(WARNING);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('a trusted session (no idle limit) never warns or expires', async () => {
    watch.noteActivity(T0);
    watch.start(null);
    await vi.advanceTimersByTimeAsync(30 * 24 * 60 * 60_000);
    expect(open).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('own activity re-arms: the dialog closes and the warning moves later', async () => {
    watch.noteActivity(T0);
    watch.start(IDLE);
    await vi.advanceTimersByTimeAsync(WARNING);
    expect(open).toHaveBeenCalledTimes(1);

    watch.noteActivity(); // e.g. "המשך עבודה" got an answer from the server
    expect(close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(WARNING - 1);
    expect(open).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('records activity in localStorage', () => {
    watch.noteActivity(T0 + 5);
    expect(localStorage.getItem(ACTIVITY_KEY)).toBe(String(T0 + 5));
  });

  it('survives blocked storage', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => watch.noteActivity(T0)).not.toThrow();
    vi.restoreAllMocks();
  });

  it('reports expiry only once the time has come', async () => {
    watch.noteActivity(T0);
    watch.start(IDLE);
    expect(watch.expired).toBe(false);
    vi.setSystemTime(T0 + EXPIRY);
    expect(watch.expired).toBe(true);
  });
});
