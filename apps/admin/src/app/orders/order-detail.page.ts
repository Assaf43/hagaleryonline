import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import type { ComponentType } from '@angular/cdk/portal';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import {
  FULFILLMENT_LABELS_HE,
  ORDER_ATTENTION_LABELS_HE,
  ORDER_STATUS_LABELS_HE,
  SHIPPING_METHOD_LABELS_HE,
  type AdminOrderDetail,
  type AdminPaymentStatus,
  type OrderStatus,
} from '@hg/models';
import { formatAmount, formatPrice } from '../catalog/catalog-format';
import { AuthService } from '../core/auth.service';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';
import { CancelDialog, type CancelDialogData } from './cancel-dialog';
import { RefundDialog, type RefundDialogData } from './refund-dialog';
import { SlotDialog, type SlotDialogData } from './slot-dialog';
import { StatusTimeline } from './status-timeline';

/** Statuses staff may cancel from (the API's rule, spec §4.2). */
const CANCELLABLE: readonly OrderStatus[] = ['pending_payment', 'paid', 'processing', 'delivery_scheduled', 'shipped'];

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

/**
 * One order in full (spec §4.4, §5.5, permission orders.view) with its status actions (`orders.manage`) and cancel /
 * refund (`orders.cancel`). The route's `:number` is bound to the input.
 */
@Component({
  selector: 'hga-order-detail-page',
  imports: [DatePipe, RouterLink, MatButtonModule, StatusTimeline],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-detail.page.html',
  styleUrl: './order-detail.page.scss',
})
export class OrderDetailPage {
  private readonly api = inject(OrdersApi);
  private readonly auth = inject(AuthService);
  private readonly dialog = inject(MatDialog);

  /** Increases with every request (the route may change the number): only the latest answer is shown. */
  private requestSeq = 0;

  readonly number = input.required<string>();

  protected readonly formatPrice = formatPrice;
  protected readonly formatAmount = formatAmount;
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
  protected readonly acting = signal(false);
  protected readonly actionError = signal('');
  protected readonly canManage = computed(() => this.auth.can('orders.manage'));
  protected readonly canCancel = computed(() => this.auth.can('orders.cancel'));
  protected readonly currentAdmin = computed(() => {
    const me = this.auth.me();
    return me ? { id: me.id, name: me.name } : null;
  });

  constructor() {
    effect(() => {
      const number = this.number();
      void this.load(number);
    });
  }

  protected advance(o: AdminOrderDetail, to: OrderStatus) {
    if (to === 'delivery_scheduled') this.openSlot(o);
    else void this.run(() => this.api.advance(o.number, { to }));
  }

  protected openSlot(o: AdminOrderDetail) {
    this.openDialog<SlotDialogData>(SlotDialog, { number: o.number, slot: o.deliverySlot });
  }

  protected openCancel(o: AdminOrderDetail) {
    this.openDialog<CancelDialogData>(CancelDialog, { number: o.number, refundable: o.refundable, status: o.status });
  }

  protected openRefund(o: AdminOrderDetail) {
    this.openDialog<RefundDialogData>(RefundDialog, { number: o.number, refundable: o.refundable });
  }

  protected retryRefund(o: AdminOrderDetail, refundId: string) {
    void this.run(() => this.api.retryRefund(o.number, refundId));
  }

  protected canCancelOrder(o: AdminOrderDetail): boolean {
    return this.canCancel() && CANCELLABLE.includes(o.status);
  }

  private openDialog<D>(component: ComponentType<unknown>, data: D) {
    this.dialog
      .open<unknown, D, AdminOrderDetail | undefined>(component, { data, width: '32rem', maxWidth: '95vw' })
      .afterClosed()
      .subscribe((order) => {
        if (order) this.order.set(order);
      });
  }

  /** An action answers with the fresh order; a refusal is shown above the actions and the order stays as it was. */
  private async run(action: () => Promise<AdminOrderDetail>) {
    if (this.acting()) return;
    this.acting.set(true);
    this.actionError.set('');
    try {
      this.order.set(await action());
    } catch (e) {
      this.actionError.set(errorMessage(e));
    } finally {
      this.acting.set(false);
    }
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
