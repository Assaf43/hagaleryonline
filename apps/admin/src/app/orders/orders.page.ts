import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { ORDER_STATUS_LABELS_HE, type AdminOrderPage, type OrderStatus } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';

const FILTERS: { status: OrderStatus | null; label: string }[] = [
  { status: null, label: 'הכול' },
  { status: 'paid', label: ORDER_STATUS_LABELS_HE.paid },
  { status: 'pending_payment', label: ORDER_STATUS_LABELS_HE.pending_payment },
  { status: 'payment_failed', label: ORDER_STATUS_LABELS_HE.payment_failed },
  { status: 'expired', label: ORDER_STATUS_LABELS_HE.expired },
];

/** Orders list (spec §5.5, permission orders.view): read-only, newest first, 30 per page, filtered by status. */
@Component({
  selector: 'hga-orders-page',
  imports: [DatePipe, RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orders.page.html',
  styleUrl: './orders.page.scss',
})
export class OrdersPage implements OnInit {
  private readonly api = inject(OrdersApi);

  protected readonly filters = FILTERS;
  protected readonly statusLabels = ORDER_STATUS_LABELS_HE;
  protected readonly formatPrice = formatPrice;
  protected readonly status = signal<OrderStatus | null>(null);
  protected readonly data = signal<AdminOrderPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  ngOnInit() {
    void this.load(1);
  }

  protected filter(status: OrderStatus | null) {
    this.status.set(status);
    void this.load(1);
  }

  protected pages(d: AdminOrderPage): number {
    return Math.max(1, Math.ceil(d.total / d.pageSize));
  }

  protected async load(page: number) {
    this.loading.set(true);
    this.error.set('');
    try {
      this.data.set(await this.api.list(this.status(), page));
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.loading.set(false);
    }
  }
}
