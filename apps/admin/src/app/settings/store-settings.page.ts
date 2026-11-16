import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import { errorMessage, STORE_NAME_MESSAGE, STORE_TEXT_MESSAGE } from '../core/errors';
import { StoreApi } from '../core/store.api';

/** The limits the API checks (`parseStoreInput`): a name of 1–80 characters, the other fields up to 200. */
const NAME_MAX = 80;
const TEXT_MAX = 200;

/**
 * "החנות" (Super Admin only, ADM-18): the one physical store's name, address, hours and phone. They are shown to
 * staff only, never on the storefront (decision 43). A bad value is refused before sending, as the API refuses it.
 */
@Component({
  selector: 'hga-store-settings-page',
  imports: [FormsModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './store-settings.page.html',
  styleUrl: './store-settings.page.scss',
})
export class StoreSettingsPage {
  private readonly api = inject(StoreApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly nameMax = NAME_MAX;
  protected readonly textMax = TEXT_MAX;
  protected readonly loaded = signal(false);
  protected readonly nameHe = signal('');
  protected readonly address = signal('');
  protected readonly hoursHe = signal('');
  protected readonly phone = signal('');
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
    const input = {
      nameHe: this.nameHe().trim(),
      address: this.address().trim(),
      hoursHe: this.hoursHe().trim(),
      phone: this.phone().trim(),
    };
    if (input.nameHe.length < 1 || input.nameHe.length > NAME_MAX) {
      this.error.set(STORE_NAME_MESSAGE);
      return;
    }
    if (input.address.length > TEXT_MAX || input.hoursHe.length > TEXT_MAX || input.phone.length > TEXT_MAX) {
      this.error.set(STORE_TEXT_MESSAGE);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      this.fill(await this.api.save(input));
      this.snack.open('נשמר', 'סגירה', { duration: 4000 });
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private fill(store: { nameHe: string; address: string; hoursHe: string; phone: string }) {
    this.nameHe.set(store.nameHe);
    this.address.set(store.address);
    this.hoursHe.set(store.hoursHe);
    this.phone.set(store.phone);
  }

  private async load() {
    this.error.set('');
    try {
      this.fill(await this.api.get());
      this.loaded.set(true);
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
