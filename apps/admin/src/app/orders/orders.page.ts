import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { DatePipe } from '@angular/common';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import {
  ORDER_ATTENTION_LABELS_HE,
  ORDER_CHANNEL_LABELS_HE,
  ORDER_STATUS_LABELS_HE,
  type AdminOrderPage,
  type AdminOrderRow,
  type OrderChannel,
  type OrderStatus,
} from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';

/** "הכול" and then every order status, in the order of the labels table. */
const FILTERS: { status: OrderStatus | null; label: string }[] = [
  { status: null, label: 'הכול' },
  ...(Object.keys(ORDER_STATUS_LABELS_HE) as OrderStatus[]).map((status) => ({
    status,
    label: ORDER_STATUS_LABELS_HE[status],
  })),
];

/** "כל הערוצים" and then the website and the store. */
const CHANNEL_FILTERS: { channel: OrderChannel | null; label: string }[] = [
  { channel: null, label: 'כל הערוצים' },
  { channel: 'web', label: ORDER_CHANNEL_LABELS_HE.web },
  { channel: 'store', label: ORDER_CHANNEL_LABELS_HE.store },
];

/** "פריט אחד" / "N פריטים". */
export function itemsLabel(count: number): string {
  return count === 1 ? 'פריט אחד' : `${count} פריטים`;
}

/**
 * Orders list (spec §5.5, permission orders.view): read-only, newest first, 30 per page. The status filter, the
 * "needs attention" view and the page live in the URL (`?status=&attention=true&page=`), so Back keeps them; the
 * route binds the query parameters to the inputs. Only the answer to the latest request is shown.
 */
@Component({
  selector: 'hga-orders-page',
  imports: [DatePipe, RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orders.page.html',
  styleUrl: './orders.page.scss',
})
export class OrdersPage {
  private readonly api = inject(OrdersApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Increases with every request; a slower, older answer finds it changed and is dropped. */
  private requestSeq = 0;

  readonly statusParam = input<string | undefined>(undefined, { alias: 'status' });
  readonly attentionParam = input<string | undefined>(undefined, { alias: 'attention' });
  readonly channelParam = input<string | undefined>(undefined, { alias: 'channel' });
  readonly pageParam = input<string | undefined>(undefined, { alias: 'page' });

  protected readonly filters = FILTERS;
  protected readonly channelFilters = CHANNEL_FILTERS;
  protected readonly channelLabels = ORDER_CHANNEL_LABELS_HE;
  protected readonly statusLabels = ORDER_STATUS_LABELS_HE;
  protected readonly attentionLabels = ORDER_ATTENTION_LABELS_HE;
  protected readonly formatPrice = formatPrice;
  protected readonly itemsLabel = itemsLabel;
  protected readonly status = computed<OrderStatus | null>(
    () => FILTERS.find((f) => f.status !== null && f.status === this.statusParam())?.status ?? null,
  );
  protected readonly channel = computed<OrderChannel | null>(
    () => CHANNEL_FILTERS.find((f) => f.channel !== null && f.channel === this.channelParam())?.channel ?? null,
  );
  protected readonly attention = computed(() => this.attentionParam() === 'true');
  protected readonly page = computed(() => {
    const n = Number(this.pageParam());
    return Number.isInteger(n) && n >= 1 && n <= 999_999 ? n : 1;
  });
  protected readonly data = signal<AdminOrderPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  constructor() {
    effect(() => {
      const status = this.status();
      const attention = this.attention();
      const page = this.page();
      const channel = this.channel();
      void this.load(status, page, attention, channel);
    });
  }

  protected filter(status: OrderStatus | null) {
    this.navigate({ status, attention: this.attention(), channel: this.channel(), page: 1 });
  }

  protected filterChannel(channel: OrderChannel | null) {
    this.navigate({ status: this.status(), attention: this.attention(), channel, page: 1 });
  }

  protected toggleAttention() {
    this.navigate({ status: this.status(), attention: !this.attention(), channel: this.channel(), page: 1 });
  }

  protected goTo(page: number) {
    this.navigate({ status: this.status(), attention: this.attention(), channel: this.channel(), page });
  }

  protected retry() {
    void this.load(this.status(), this.page(), this.attention(), this.channel());
  }

  protected pages(d: AdminOrderPage): number {
    return Math.max(1, Math.ceil(d.total / d.pageSize));
  }

  protected reasons(o: AdminOrderRow): string {
    return o.attentionReasons.map((r) => this.attentionLabels[r]).join(', ');
  }

  private navigate(state: {
    status: OrderStatus | null;
    attention: boolean;
    channel: OrderChannel | null;
    page: number;
  }) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: {
        status: state.status,
        attention: state.attention ? 'true' : null,
        channel: state.channel,
        page: state.page > 1 ? state.page : null,
      },
    });
  }

  private async load(status: OrderStatus | null, page: number, attention: boolean, channel: OrderChannel | null) {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.list(status, page, attention, channel);
      if (seq === this.requestSeq) this.data.set(result);
    } catch (e) {
      if (seq !== this.requestSeq) return;
      // Never leave the rows of another filter under this one.
      this.data.set(null);
      this.error.set(errorMessage(e));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
