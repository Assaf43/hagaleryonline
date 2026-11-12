import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatRadioModule } from '@angular/material/radio';
import type { AdminCancelRequest, AdminOrderDetail, CancelRefundChoice, OrderStatus } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';
import { parseShekels } from './shekels';

export interface CancelDialogData {
  number: number;
  /** Agorot that can still be refunded; 0 means no refund options (an unpaid order). */
  refundable: number;
  status: OrderStatus;
}

/** Cancels an order (decision 74): how much to refund, why, and whether the items go back to stock. */
@Component({
  selector: 'hga-cancel-dialog',
  imports: [MatButtonModule, MatCheckboxModule, MatDialogModule, MatFormFieldModule, MatInputModule, MatRadioModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h2 mat-dialog-title>ביטול הזמנה</h2>
    <form (submit)="submit($event)">
      <mat-dialog-content class="dialog-form">
        @if (data.refundable > 0) {
          <mat-radio-group aria-label="החזר כספי" [value]="choice()" (change)="choice.set($event.value)">
            <mat-radio-button value="full">החזר מלא ({{ formatPrice(data.refundable) }})</mat-radio-button>
            <mat-radio-button value="partial">החזר חלקי</mat-radio-button>
            <mat-radio-button value="none">ללא החזר</mat-radio-button>
          </mat-radio-group>
          @if (choice() === 'partial') {
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
          }
        }
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
        @if (data.status !== 'pending_payment') {
          <mat-checkbox [checked]="restock()" (change)="restock.set($event.checked)">להחזיר למלאי</mat-checkbox>
        }
        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }
      </mat-dialog-content>
      <mat-dialog-actions align="end">
        <button matButton type="button" mat-dialog-close>חזרה</button>
        <button matButton="filled" type="submit" [disabled]="!valid() || busy()">ביטול ההזמנה</button>
      </mat-dialog-actions>
    </form>
  `,
})
export class CancelDialog {
  private readonly api = inject(OrdersApi);
  private readonly ref = inject<MatDialogRef<CancelDialog, AdminOrderDetail>>(MatDialogRef);
  protected readonly data = inject<CancelDialogData>(MAT_DIALOG_DATA);
  protected readonly formatPrice = formatPrice;

  protected readonly choice = signal<CancelRefundChoice>(this.data.refundable > 0 ? 'full' : 'none');
  protected readonly amountText = signal('');
  protected readonly reason = signal('');
  protected readonly restock = signal(true);
  protected readonly busy = signal(false);
  protected readonly error = signal('');

  /** Agorot typed for a partial refund, or null when missing or above the refundable amount. */
  private readonly amount = computed(() => {
    const agorot = parseShekels(this.amountText());
    return agorot !== null && agorot > 0 && agorot <= this.data.refundable ? agorot : null;
  });

  protected readonly valid = computed(() => {
    const reason = this.reason().trim();
    if (reason.length < 3 || reason.length > 500) return false;
    return this.choice() !== 'partial' || this.amount() !== null;
  });

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async submit(event: Event) {
    event.preventDefault();
    if (!this.valid() || this.busy()) return;
    const request: AdminCancelRequest = {
      refund: this.choice(),
      reason: this.reason().trim(),
      restock: this.data.status !== 'pending_payment' && this.restock(),
    };
    if (this.choice() === 'partial') request.amount = this.amount()!;
    this.busy.set(true);
    this.error.set('');
    try {
      this.ref.close(await this.api.cancel(this.data.number, request));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }
}
