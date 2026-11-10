import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import type { OrderStatus, OrderView } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { deliveryEstimateText, formatPrice } from '../core/format';
import { PageMeta } from '../core/page-meta';
import {
  CheckoutApi,
  ExternalNavigation,
  SHIPPING_METHOD_LABELS_HE,
  apiErrorCode,
  checkoutErrorMessage,
} from '../checkout/checkout.api';

const POLL_MS = 3000;
/** A pending order is polled for at most this long; then the customer can check again by hand. */
const POLL_FOR_MS = 60_000;

const STATUS_TITLES: Record<OrderStatus, string> = {
  paid: 'ההזמנה התקבלה ושולמה',
  pending_payment: 'ממתינים לאישור התשלום…',
  payment_failed: 'התשלום לא הושלם',
  expired: 'זמן התשלום עבר',
};

/**
 * Order confirmation `/order/:number?t=<token>` (spec §5.5, CHK-04): status, lines, address, method, totals and
 * delivery estimate. The token is the only key, so the order is read only in the browser (the server renders a
 * shell). A pending order is re-read every 3 s for up to a minute; a paid one refreshes the cart (the webhook
 * emptied it); a failed or expired one offers "נסו לשלם שוב" while the API allows it, otherwise the cart.
 */
@Component({
  selector: 'hg-order-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order.page.html',
  styleUrl: './order.page.scss',
})
export class OrderPage {
  readonly number = input.required<string>();
  /** The order's public token (query parameter `t`). */
  readonly t = input<string>();

  private readonly api = inject(CheckoutApi);
  private readonly cart = inject(CartStore);
  private readonly external = inject(ExternalNavigation);
  private readonly meta = inject(PageMeta);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly order = signal<OrderView | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  /** Polling stopped while still pending. */
  protected readonly pollingStopped = signal(false);
  protected readonly retrying = signal(false);
  protected readonly retryError = signal('');

  protected readonly title = computed(() => {
    const o = this.order();
    return o ? STATUS_TITLES[o.status] : '';
  });
  protected readonly failed = computed(() => {
    const s = this.order()?.status;
    return s === 'payment_failed' || s === 'expired';
  });
  /** "הרצל 12, דירה 5, תל אביב - יפו". */
  protected readonly addressLine = computed(() => {
    const a = this.order()?.address;
    if (!a) return '';
    const apartment = a.apartment ? `, דירה ${a.apartment}` : '';
    return `${a.street} ${a.houseNumber}${apartment}, ${a.localityNameHe}`;
  });
  protected readonly estimate = computed(() => {
    const e = this.order()?.deliveryEstimate;
    return e ? deliveryEstimateText(e.leadTimeDays) : '';
  });
  protected readonly methodLabels = SHIPPING_METHOD_LABELS_HE;
  protected readonly price = formatPrice;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private pollStart = 0;
  /** Bumped on every new load, so answers for an older number or token are dropped. */
  private generation = 0;
  private cartRefreshed = false;

  constructor() {
    effect(() => {
      const number = this.number();
      const token = this.t() ?? '';
      untracked(() => {
        this.meta.set({
          title: 'פרטי ההזמנה',
          description: 'מצב ההזמנה ופרטיה',
          path: `/order/${encodeURIComponent(number)}`,
          noindex: true,
        });
        if (this.browser) this.start(number, token);
      });
    });
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  private start(number: string, token: string): void {
    this.stopTimer();
    this.generation++;
    this.order.set(null);
    this.state.set('loading');
    this.cartRefreshed = false;
    this.pollStart = Date.now();
    this.pollingStopped.set(false);
    void this.read(number, token, this.generation);
  }

  private async read(number: string, token: string, generation: number): Promise<void> {
    let view: OrderView;
    try {
      view = await this.api.order(number, token);
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.order()) {
        // A failed poll keeps what is shown and tries again.
        this.schedule(number, token, generation);
      } else {
        this.state.set(apiErrorCode(error) === 'not_found' ? 'not_found' : 'error');
      }
      return;
    }
    if (generation !== this.generation) return;
    this.order.set(view);
    this.state.set('ready');
    if (view.status === 'pending_payment') this.schedule(number, token, generation);
    if (view.status === 'paid' && !this.cartRefreshed) {
      this.cartRefreshed = true;
      void this.cart.load();
    }
  }

  private schedule(number: string, token: string, generation: number): void {
    if (Date.now() - this.pollStart + POLL_MS > POLL_FOR_MS) {
      this.pollingStopped.set(true);
      return;
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.read(number, token, generation);
    }, POLL_MS);
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  protected reload(): void {
    this.start(this.number(), this.t() ?? '');
  }

  /** Same order, checked again by hand after polling stopped. */
  protected checkAgain(): void {
    this.pollStart = Date.now();
    this.pollingStopped.set(false);
    void this.read(this.number(), this.t() ?? '', this.generation);
  }

  protected async retryPayment(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    this.retryError.set('');
    try {
      const { redirectUrl } = await this.api.retryPayment(this.number(), this.t() ?? '');
      this.external.assign(redirectUrl);
    } catch (error) {
      this.retrying.set(false);
      this.retryError.set(checkoutErrorMessage(apiErrorCode(error)));
    }
  }
}
