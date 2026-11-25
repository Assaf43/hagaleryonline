import { Injectable, inject } from '@angular/core';
import { MatDialog, type MatDialogRef } from '@angular/material/dialog';
import { Router } from '@angular/router';
import { ADMIN_SESSION_TOUCH_MS } from '@hg/models';
import { IdleWarningDialog } from '../shell/idle-warning.dialog';
import { AuthService } from './auth.service';

export const ACTIVITY_KEY = 'hg.admin.activity';

/** How long before our own logout time the warning appears. */
export const IDLE_WARNING_MS = 5 * 60_000;

/**
 * Warns before the 8-hour idle logout (decision 53). Every successful admin API call is "activity" and is shared
 * with the other tabs through localStorage, so work in one tab postpones the warning in all of them. The server
 * writes a session's last-seen time at most every `ADMIN_SESSION_TOUCH_MS`, so its own cut-off can come that much
 * earlier than `last + idle`; we expire (and warn) before it, never after. A "remember this device" session has no
 * idle limit (`idleTimeoutMs` null) and never warns.
 */
@Injectable({ providedIn: 'root' })
export class IdleWatch {
  private readonly dialog = inject(MatDialog);
  private readonly auth = inject(AuthService);
  private readonly router = inject(Router);

  private idleMs: number | null = null;
  private endedByIdle = false;
  private last = Date.now();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private dialogRef: MatDialogRef<IdleWarningDialog> | null = null;
  private readonly onStorage = (event: StorageEvent) => {
    if (event.key !== ACTIVITY_KEY || this.idleMs === null) return;
    const at = Number(event.newValue);
    if (Number.isFinite(at) && at > this.last) {
      this.last = at;
      this.evaluate();
    }
  };

  /** Called by the shell once the user is known. `null` = no idle limit, so nothing to watch. */
  start(idleTimeoutMs: number | null) {
    this.stop();
    this.endedByIdle = false;
    if (idleTimeoutMs === null) return;
    this.idleMs = idleTimeoutMs;
    this.last = Math.max(this.last, this.storedActivity());
    window.addEventListener('storage', this.onStorage);
    this.evaluate();
  }

  stop() {
    clearTimeout(this.timer);
    this.timer = undefined;
    window.removeEventListener('storage', this.onStorage);
    this.closeDialog();
    this.idleMs = null;
  }

  /** True once the time to log out has passed, until the next `start()` (tells an idle 401 from any other). */
  get expired(): boolean {
    return this.endedByIdle || (this.idleMs !== null && Date.now() >= this.expiresAt());
  }

  noteActivity(at = Date.now()) {
    this.last = Math.max(this.last, at);
    try {
      localStorage.setItem(ACTIVITY_KEY, String(this.last));
    } catch {
      // Storage can be blocked; this tab still tracks its own activity.
    }
    if (this.idleMs !== null) this.evaluate();
  }

  private expiresAt() {
    return this.last + (this.idleMs ?? 0) - ADMIN_SESSION_TOUCH_MS;
  }

  private warnAt() {
    return this.expiresAt() - IDLE_WARNING_MS;
  }

  private storedActivity(): number {
    try {
      const at = Number(localStorage.getItem(ACTIVITY_KEY));
      return Number.isFinite(at) ? at : 0;
    } catch {
      return 0;
    }
  }

  /** One timer, always aimed at the next moment that matters; re-evaluated whenever the activity changes. */
  private evaluate() {
    clearTimeout(this.timer);
    // Another tab may have been active while this one was frozen, before its storage event arrived.
    this.last = Math.max(this.last, this.storedActivity());
    const now = Date.now();
    if (now >= this.expiresAt()) {
      void this.expire();
      return;
    }
    if (now >= this.warnAt()) {
      if (!this.dialogRef) {
        const ref = this.dialog.open(IdleWarningDialog, { width: '440px', maxWidth: '95vw', disableClose: true });
        ref.afterClosed().subscribe(() => {
          if (this.dialogRef === ref) this.dialogRef = null;
        });
        this.dialogRef = ref;
      }
      this.timer = setTimeout(() => this.evaluate(), this.expiresAt() - now);
      return;
    }
    this.closeDialog();
    this.timer = setTimeout(() => this.evaluate(), this.warnAt() - now);
  }

  private closeDialog() {
    const ref = this.dialogRef;
    this.dialogRef = null;
    ref?.close();
  }

  private async expire() {
    this.stop();
    this.endedByIdle = true;
    // Best effort: end the server session too, even if its clock differs from ours.
    await this.auth.logout().catch(() => this.auth.clear());
    await this.router.navigateByUrl('/login?reason=idle');
  }
}
