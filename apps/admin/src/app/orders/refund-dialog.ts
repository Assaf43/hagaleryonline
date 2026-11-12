import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import type { AdminOrderDetail } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';
import { parseShekels } from './shekels';

export interface RefundDialogData {
  number: number;
  /** Agorot that can still be refunded. */
  refundable: number;
}

/** A refund without cancelling the order: an amount (shekels, up to what is left) and a reason. */
@Component({
  selector: 'hga-refund-dialog',
  imports: [MatButtonModule, MatDialogModule, MatFormFieldModule, MatInputModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>החזר כספי</h2>
    <form (submit)="submit($event)">
      <mat-dialog-content class="dialog-form">
        <mat-form-field>
          <mat-label>סכום להחזר בשקלים</mat-label>
          <input
            matInput
            name="amount"
            inputmode="decimal"
            dir="ltr"
            [value]="amountText()"
            (input)="amountText.set(value($event))"
          />
          <mat-hint>עד {{ formatPrice(data.refundable) }}</mat-hint>
        </mat-form-field>
        <mat-form-field>
          <mat-label>סיבה</mat-label>
          <textarea
            matInput
            name="reason"
            rows="3"
            maxlength="500"
            [value]="reason()"
            (input)="reason.set(value($event))"
          ></textarea>
        </mat-form-field>
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>חזרה</button>
        <button matButton="filled" type="submit" [disabled]="!valid() || busy()">ביצוע החזר</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class RefundDialog {
  private readonly api = inject(OrdersApi);
  private readonly ref = inject<MatDialogRef<RefundDialog, AdminOrderDetail>>(MatDialogRef);
  protected readonly data = inject<RefundDialogData>(MAT_DIALOG_DATA);
  protected readonly formatPrice = formatPrice;

  protected readonly amountText = signal('');
  protected readonly reason = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  private readonly amount = computed(() => {
    const agorot = parseShekels(this.amountText());
    return agorot !== null && agorot > 0 && agorot <= this.data.refundable ? agorot : null;
  });

  protected readonly valid = computed(() => {
    const reason = this.reason().trim();
    return this.amount() !== null && reason.length >= 3 && reason.length <= 500;
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event) {
    event.preventDefault();
    if (!this.valid() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      this.ref.close(await this.api.refund(this.data.number, { amount: this.amount()!, reason: this.reason().trim() }));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
