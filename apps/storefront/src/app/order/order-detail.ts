import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { INVOICE_TYPE_LABELS_HE, SHIPPING_METHOD_LABELS_HE, type OrderStatus, type OrderView } from '@hg/models';
import { DiscountAmount } from '../core/discount-amount';
import { deliveryEstimateText, formatPrice } from '../core/format';

/** Headlines that keep their Phase 4 wording; every other status shows the API's `statusLabelHe`. */
export const ORDER_STATUS_TITLES: Partial<Record<OrderStatus, string>> = {
  paid: 'ההזמנה התקבלה ושולמה',
  pending_payment: 'ממתינים לאישור התשלום…',
  cancelled: 'ההזמנה בוטלה',
  payment_failed: 'התשלום לא הושלם',
  expired: 'זמן התשלום עבר',
};

/**
 * The body of an order page (spec §5.5): order number, lines, delivery address and method, totals and tax
 * documents. Shared by `/order/:number` (the order link) and `/account/orders/:number` (Phase 5c); the status
 * headline and the actions (cancel, retry) stay with the page. Documents are listed only when the page gives
 * `documentUrl`, because opening one needs the order token (the account pages do not have it).
 */
@Component({
  selector: 'hg-order-detail',
  imports: [DiscountAmount],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-detail.html',
  styleUrl: './order-detail.scss',
})
export class OrderDetail {
  readonly order = input.required<OrderView>();
  readonly documentUrl = input<((id: string) => string) | null>(null);

  /** "הרצל 12, דירה 5, תל אביב - יפו". */
  protected readonly addressLine = computed(() => {
    const a = this.order().address;
    const apartment = a.apartment ? `, דירה ${a.apartment}` : '';
    return `${a.street} ${a.houseNumber}${apartment}, ${a.localityNameHe}`;
  });
  protected readonly estimate = computed(() => {
    const e = this.order().deliveryEstimate;
    return e ? deliveryEstimateText(e.leadTimeDays) : '';
  });
  protected readonly methodLabels = SHIPPING_METHOD_LABELS_HE;
  protected readonly invoiceLabels = INVOICE_TYPE_LABELS_HE;
  protected readonly price = formatPrice;
}
