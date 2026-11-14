import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { RETURN_WINDOW_LIMITS } from '@hg/models';
import { errorMessage, RETURN_WINDOW_MESSAGE } from '../core/errors';
import { SupportApi } from '../core/support.api';

/**
 * "ימי החזרה" (spec §3, SRV-02; Super Admin or orders.manage): how many days after delivery a customer can ask for a
 * return or an exchange. Whole days, 1–60; a bad number is refused before sending, as the API refuses it.
 */
@Component({
  selector: 'hga-return-window-page',
  imports: [FormsModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './return-window.page.html',
  styleUrl: './return-window.page.scss',
})
export class ReturnWindowPage {
  private readonly api = inject(SupportApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly limits = RETURN_WINDOW_LIMITS;
  protected readonly loaded = signal(false);
  protected readonly days = signal<number | string | null>('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);

  constructor() {
    void this.load();
  }

  protected reload() {
    void this.load();
  }

  protected async save(event: Event) {
    event.preventDefault();
    const typed = String(this.days() ?? '').trim();
    const days = Number(typed);
    if (!/^\d{1,2}$/.test(typed) || days < RETURN_WINDOW_LIMITS.min || days > RETURN_WINDOW_LIMITS.max) {
      this.error.set(RETURN_WINDOW_MESSAGE);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.days.set((await this.api.saveStoreSettings({ returnWindowDays: days })).returnWindowDays);
      this.snack.open('נשמר', 'סגירה', { duration: 4000 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async load() {
    this.error.set('');
    try {
      this.days.set((await this.api.storeSettings()).returnWindowDays);
      this.loaded.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
