import { ChangeDetectionStrategy, Component, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  FULFILLMENT_LABELS_HE,
  ORDER_STATUS_LABELS_HE,
  type AdminOrderDetail,
  type AdminPaymentStatus,
  type ShippingMethod,
} from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';

const METHOD_LABELS: Record<ShippingMethod, string> = {
  curbside: 'משלוח עד הבית',
  full_service: 'משלוח עם סבלות והרכבה',
};

const PAYMENT_LABELS: Record<AdminPaymentStatus, string> = {
  pending: 'ממתין',
  succeeded: 'הצליח',
  failed: 'נכשל',
  cancelled: 'בוטל',
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

  readonly number = input.required<string>();

  protected readonly formatPrice = formatPrice;
  protected readonly statusLabels = ORDER_STATUS_LABELS_HE;
  protected readonly methodLabels = METHOD_LABELS;
  protected readonly paymentLabels = PAYMENT_LABELS;
  protected readonly fulfillmentLabels = FULFILLMENT_LABELS_HE;
  protected readonly order = signal<AdminOrderDetail | null>(null);
  protected readonly error = signal('');

  constructor() {
    effect(() => {
      const number = this.number();
      void this.load(number);
    });
  }

  private async load(number: string) {
    this.order.set(null);
    this.error.set('');
    try {
      this.order.set(await this.api.detail(number));
    } catch (e) {
      this.error.set((e as { status?: number }).status === 404 ? 'ההזמנה לא נמצאה.' : errorMessage(e));
    }
  }
}
