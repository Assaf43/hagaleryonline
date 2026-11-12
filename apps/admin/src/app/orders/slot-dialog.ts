import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { AdminOrderDetail, DeliverySlotView } from '@hg/models';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';

export interface SlotDialogData {
  number: number;
  /** The current slot when staff change it; null for the first one. */
  slot: DeliverySlotView | null;
}

/** Which field of the slot is wrong, or null. The window must start before it ends (HH:MM compares as text). */
export function validateSlot(slot: { date: string; windowFrom: string; windowTo: string }): 'date' | 'window' | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(slot.date)) return 'date';
  if (!/^\d{2}:\d{2}$/.test(slot.windowFrom) || !/^\d{2}:\d{2}$/.test(slot.windowTo)) return 'window';
  return slot.windowFrom < slot.windowTo ? null : 'window';
}

const MESSAGES = {
  date: 'יש לבחור תאריך אספקה.',
  window: 'יש לבחור שעות אספקה. שעת ההתחלה צריכה להיות לפני שעת הסיום.',
};

/** Moves an order to "delivery scheduled" with a date and a time window, or changes the slot of one already there. */
@Component({
  selector: 'hga-slot-dialog',
  imports: [MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>{{ data.slot ? 'שינוי מועד האספקה' : 'תיאום אספקה' }}</h2>
    <form (submit)="submit($event)">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>תאריך</mat-label>
          <input matInput type="date" name="date" dir="ltr" [value]="date()" (input)="date.set(value($event))" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>משעה</mat-label>
          <input matInput type="time" name="from" dir="ltr" [value]="from()" (input)="from.set(value($event))" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>עד שעה</mat-label>
          <input matInput type="time" name="to" dir="ltr" [value]="to()" (input)="to.set(value($event))" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>הערה ללקוח (לא חובה)</mat-label>
          <input matInput name="note" maxlength="200" [value]="note()" (input)="note.set(value($event))" />
        </mat-form-field>
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>ביטול</button>
        <button matButton="filled" type="submit" [disabled]="busy()">שמירה</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class SlotDialog {
  private readonly api = inject(OrdersApi);
  private readonly ref = inject<MatDialogRef<SlotDialog, AdminOrderDetail>>(MatDialogRef);
  protected readonly data = inject<SlotDialogData>(MAT_DIALOG_DATA);

  protected readonly date = signal(this.data.slot?.date ?? '');
  protected readonly from = signal(this.data.slot?.windowFrom ?? '');
  protected readonly to = signal(this.data.slot?.windowTo ?? '');
  protected readonly note = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event) {
    event.preventDefault();
    if (this.busy()) return;
    const slot = { date: this.date(), windowFrom: this.from(), windowTo: this.to() };
    const problem = validateSlot(slot);
    if (problem) {
      this.error.set(MESSAGES[problem]);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const note = this.note().trim();
      const order = await this.api.advance(this.data.number, {
        to: 'delivery_scheduled',
        slot: note ? { ...slot, note } : slot,
      });
      this.ref.close(order);
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
