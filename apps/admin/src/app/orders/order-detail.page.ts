import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  FULFILLMENT_LABELS_HE,
  ORDER_ATTENTION_LABELS_HE,
  ORDER_STATUS_LABELS_HE,
  SHIPPING_METHOD_LABELS_HE,
  type AdminOrderDetail,
  type AdminPaymentStatus,
} from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';

const PAYMENT_LABELS: Record<AdminPaymentStatus, string> = {
  pending: 'ממתין',
  succeeded: 'הצליח',
  failed: 'נכשל',
  cancelled: 'בוטל',
};

/** What the API writes into a payment's `rawStatus` when the payment needs a person; other values are the provider's. */
const RAW_STATUS_LABELS: Record<string, string> = {
  paid_twice: 'שולם פעמיים',
  amount_mismatch: 'סכום לא תואם',
  superseded_paid: 'שולם אחרי שנוצרה הזמנה חדשה מאותו סל',
};

/** One order in full (spec §5.5, permission orders.view): read-only. The route's `:number` is bound to the input. */
@Component({
  selector: 'hga-order-detail-page',
  imports: [DatePipe, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-detail.page.html',
  styleUrl: './order-detail.page.scss',
})
export class OrderDetailPage {
  private readonly api = inject(OrdersApi);

  /** Increases with every request (the route may change the number): only the latest answer is shown. */
  private requestSeq = 0;

  readonly number = input.required<string>();

  protected readonly formatPrice = formatPrice;
  protected readonly installmentsLabel = (n: number) => (n === 1 ? 'תשלום אחד' : `${n} תשלומים`);
  protected readonly statusLabels = ORDER_STATUS_LABELS_HE;
  /** The customer's wording, so staff and customer name the method the same way. */
  protected readonly methodLabels = SHIPPING_METHOD_LABELS_HE;
  protected readonly paymentLabels = PAYMENT_LABELS;
  protected readonly fulfillmentLabels = FULFILLMENT_LABELS_HE;
  protected readonly order = signal<AdminOrderDetail | null>(null);
  protected readonly error = signal('');
  protected readonly loading = signal(true);
  protected readonly attentionLabels = ORDER_ATTENTION_LABELS_HE;
  protected readonly rawStatusLabels = RAW_STATUS_LABELS;

  constructor() {
    effect(() => {
      const number = this.number();
      void this.load(number);
    });
  }

  private async load(number: string) {
    const seq = ++this.requestSeq;
    this.order.set(null);
    this.error.set('');
    this.loading.set(true);
    try {
      const order = await this.api.detail(number);
      if (seq === this.requestSeq) this.order.set(order);
    } catch (e) {
      if (seq === this.requestSeq)
        this.error.set((e as { status?: number }).status === 404 ? 'ההזמנה לא נמצאה.' : errorMessage(e));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
