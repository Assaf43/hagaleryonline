import { ChangeDetectionStrategy, Component, input, output } from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import type { StorePendingOrder } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { FORM_STYLES } from './form.styles';

/** The seller's store orders that are not paid yet; the buttons come from `actions`, never from the status. */
@Component({
  selector: 'hga-pending-orders',
  imports: [MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styles: [FORM_STYLES],
  template: `
    @if (orders().length > 0) {
      <section aria-label="הזמנות שממתינות לתשלום">
        <h2>ממתינות לתשלום</h2>
        <ul class="list">
          @for (o of orders(); track o.number) {
            <li class="card">
              <span>
                <bdi>{{ o.number }}</bdi> · {{ o.fullName }} · <bdi>{{ price(o.total) }}</bdi>
                <span class="muted">· {{ o.status === 'payment_failed' ? 'התשלום נכשל' : 'ממתינה לתשלום' }}</span>
              </span>
              <span class="actions">
                @if (o.actions.includes('retry')) {
                  <button
                    matButton="filled"
                    type="button"
                    [disabled]="busy()"
                    [attr.aria-label]="'נסה שוב, הזמנה ' + o.number"
                    (click)="retry.emit(o.number)"
                  >
                    נסה שוב
                  </button>
                }
                @if (o.actions.includes('cancel')) {
                  <button
                    matButton="outlined"
                    type="button"
                    [disabled]="busy()"
                    [attr.aria-label]="'בטל, הזמנה ' + o.number"
                    (click)="cancel.emit(o.number)"
                  >
                    בטל
                  </button>
                }
              </span>
            </li>
          }
        </ul>
      </section>
    }
  `,
})
export class PendingOrders {
  readonly orders = input<StorePendingOrder[]>([]);
  /** A request is in flight: the buttons wait, so a double tap never opens two payment pages. */
  readonly busy = input(false);
  readonly retry = output<number>();
  readonly cancel = output<number>();
  protected readonly price = formatPrice;
}
