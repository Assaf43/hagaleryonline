import { HttpErrorResponse } from '@angular/common/http';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { SHIPPING_METHOD_LABELS_HE } from '@hg/models';
import type { StoreCartView, StoreOrderRequest, StorePendingOrder } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorCode, storeErrorMessage } from './store-errors';
import { StoreOrdersApi } from '../core/store-orders.api';
import { ConfirmDialog } from '../orders/confirm-dialog';
import { CustomerStep } from './customer-step';
import { DeliveryStep } from './delivery-step';
import { PendingOrders } from './pending-orders';
import { ProductPicker } from './product-picker';
import { STEPS, STEP_LABELS, canEnter, stepAfterError, type DeliveryChoice, type SaleStep } from './steps';

/** Order statuses where the payment did not go through: the seller may try again. */
const FAILED = new Set(['payment_failed']);
/** Orders that cannot be paid any more: the seller starts a new sale. */
const CLOSED = new Set(['expired', 'cancelled']);

type PaymentState = 'waiting' | 'paid' | 'failed' | 'closed';

/** How often the status of the order is asked while the page is visible. */
export const POLL_MS = 5000;

/**
 * "מכירה בחנות" (spec §4.1, ADM-18): a tablet screen in five steps — products, customer, delivery, summary and payment
 * status. The seller's cart lives on the server; the payment page opens in a new tab and this page polls the order.
 */
@Component({
  selector: 'hga-store-sale-page',
  imports: [MatButtonModule, ProductPicker, CustomerStep, DeliveryStep, PendingOrders],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './store-sale.page.html',
  styleUrl: './store-sale.page.scss',
})
export class StoreSalePage {
  private readonly api = inject(StoreOrdersApi);
  private readonly dialog = inject(MatDialog);
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private timer: ReturnType<typeof setInterval> | null = null;

  protected readonly steps = STEPS;
  protected readonly labels = STEP_LABELS;
  protected readonly price = formatPrice;
  protected readonly methodLabels = SHIPPING_METHOD_LABELS_HE;

  readonly step = signal<SaleStep>('products');
  readonly cart = signal<StoreCartView | null>(null);
  readonly delivery = signal<DeliveryChoice | null>(null);
  readonly orderNumber = signal<number | null>(null);
  /** True once an order exists for this sale (not for a pending order the seller reopens). */
  readonly locked = signal(false);
  readonly payment = signal<PaymentState>('waiting');
  readonly pending = signal<StorePendingOrder[]>([]);
  protected readonly payUrl = signal<string | null>(null);
  /** The browser refused to open the payment page: the seller opens it with a button (M1). */
  protected readonly popupBlocked = signal(false);
  protected readonly acceptTerms = signal(false);
  protected readonly marketing = signal(false);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly loaded = signal(false);

  protected readonly state = computed(() => ({
    cart: this.cart(),
    delivery: this.delivery(),
    orderNumber: this.orderNumber(),
    locked: this.locked(),
  }));
  protected readonly discount = computed(() => this.cart()?.discount?.amount ?? 0);
  protected readonly total = computed(() => {
    const cart = this.cart();
    return cart ? cart.subtotal - this.discount() + (this.delivery()?.shippingTotal ?? 0) : 0;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.stopPolling();
      document.removeEventListener('visibilitychange', this.onShown);
    });
    // Back on this tab (e.g. from the payment page): the pending list may have changed meanwhile (M5).
    document.addEventListener('visibilitychange', this.onShown);
    // Move the focus to the heading of each new step (not on the first render).
    let first = true;
    effect(() => {
      this.step();
      if (first) {
        first = false;
        return;
      }
      untracked(() =>
        afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>('[data-step-heading]')?.focus(), {
          injector: this.injector,
        }),
      );
    });
    void this.load();
  }

  private async load() {
    try {
      // No open cart (first visit, after a paid sale): a sale starts at once, so adding a product works (I2).
      this.cart.set((await this.api.cart()) ?? (this.locked() ? null : await this.api.startSale()));
    } catch (e) {
      this.error.set(storeErrorMessage(e));
    }
    await this.loadPending();
    this.loaded.set(true);
  }

  protected can(step: SaleStep): boolean {
    return canEnter(step, this.state());
  }

  goTo(step: SaleStep) {
    if (!this.can(step)) return;
    this.error.set('');
    this.step.set(step);
  }

  /** The cart or the customer changed: the delivery is chosen again, for the new lines, total and account. */
  onCart(view: StoreCartView) {
    this.cart.set(view);
    this.delivery.set(null);
  }

  /** An API error from a step: a lapsed customer confirmation sends the seller back to the customer step. */
  onFailed(error: unknown) {
    const target = stepAfterError(error);
    if (target) {
      void this.refreshCart();
      this.step.set(target);
    }
  }

  private async refreshCart() {
    try {
      this.cart.set(await this.api.cart());
    } catch {
      // The step already shows its own error.
    }
  }

  onDelivery(choice: DeliveryChoice) {
    this.delivery.set(choice);
    this.step.set('summary');
  }

  /** The "מכירה חדשה" button: asks first when the open sale has lines or a customer and no order yet (I4). */
  async onNewSale() {
    const cart = this.cart();
    const hasWork = !!cart && (cart.lines.length > 0 || !!cart.customer);
    if (!this.locked() && hasWork) {
      const sure = await this.confirm('להתחיל מכירה חדשה? העגלה והלקוח של המכירה הנוכחית יימחקו.');
      if (!sure) return;
    }
    await this.newSale();
  }

  private confirm(message: string): Promise<boolean> {
    return new Promise<boolean>((resolve) =>
      this.dialog
        .open(ConfirmDialog, { data: { message } })
        .afterClosed()
        .subscribe((v) => resolve(v === true)),
    );
  }

  async newSale() {
    this.stopPolling();
    this.pollFailed = false;
    this.busy.set(true);
    try {
      this.cart.set(await this.api.startSale());
      this.delivery.set(null);
      this.orderNumber.set(null);
      this.locked.set(false);
      this.payUrl.set(null);
      this.popupBlocked.set(false);
      this.acceptTerms.set(false);
      this.marketing.set(false);
      this.payment.set('waiting');
      this.error.set('');
      this.step.set('products');
    } catch (e) {
      this.error.set(storeErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  protected setTerms(event: Event) {
    this.acceptTerms.set((event.target as HTMLInputElement).checked);
  }

  protected setMarketing(event: Event) {
    this.marketing.set((event.target as HTMLInputElement).checked);
  }

  /** "לתשלום": places the order and opens the provider's page in a new tab. */
  async pay() {
    const delivery = this.delivery();
    if (!delivery || !this.acceptTerms() || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const linesBefore = this.lineKey();
    const request: StoreOrderRequest = {
      address: delivery.address,
      method: delivery.method,
      acceptTerms: true,
      expectedTotal: this.total(),
      marketingConsent: this.marketing(),
      saveAddress: delivery.saveAddress,
    };
    try {
      const created = await this.api.createOrder(request);
      this.orderNumber.set(created.number);
      this.locked.set(true);
      this.openPayment(created.redirectUrl);
      this.beginStatus();
      void this.loadPending();
    } catch (e) {
      const body = e instanceof HttpErrorResponse ? (e.error as { code?: string; number?: number } | null) : null;
      if (body?.code === 'order_pending' && typeof body.number === 'number') {
        // The sale already has an order: show it, with "נסה שוב" for a new payment page.
        this.orderNumber.set(body.number);
        this.locked.set(true);
        this.payUrl.set(null);
        this.beginStatus();
        this.error.set(storeErrorMessage(e));
      } else {
        this.error.set(storeErrorMessage(e));
        this.onFailed(e);
        if (errorCode(e) === 'price_changed') {
          await this.refreshCart();
          // Other lines or quantities mean another shipping total: the delivery is chosen again (M6).
          if (this.lineKey() !== linesBefore) {
            this.delivery.set(null);
            this.step.set('delivery');
          }
        }
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** What the order depends on in the cart lines: a change means the delivery quote is stale. */
  private lineKey(): string {
    return JSON.stringify((this.cart()?.lines ?? []).map((l) => [l.variantId, l.quantity, l.available, l.lineTotal]));
  }

  private openPayment(url: string) {
    this.payUrl.set(url);
    // `noopener` would hide whether the tab opened, so the opener link is cut right after opening instead.
    const opened = window.open(url, '_blank');
    if (opened) opened.opener = null;
    this.popupBlocked.set(!opened);
  }

  private beginStatus() {
    this.payment.set('waiting');
    this.step.set('status');
    this.startPolling();
  }

  /** A new payment page for the order on the status step. */
  async retryPayment(number: number | null = this.orderNumber()) {
    if (number === null) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const { redirectUrl } = await this.api.retry(number);
      this.orderNumber.set(number);
      this.openPayment(redirectUrl);
      this.beginStatus();
      void this.loadPending();
    } catch (e) {
      this.error.set(storeErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  async cancelOrder(number: number) {
    const sure = await this.confirm(`לבטל את הזמנה ${number}? הלקוח לא יחויב.`);
    if (!sure) return;
    this.busy.set(true);
    try {
      await this.api.cancel(number);
      if (this.orderNumber() === number) {
        this.stopPolling();
        this.payment.set('closed');
      }
      await this.loadPending();
    } catch (e) {
      this.error.set(storeErrorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private pendingLoading = false;

  async loadPending() {
    if (this.pendingLoading) return;
    this.pendingLoading = true;
    try {
      this.pending.set(await this.api.pending());
    } catch {
      // The list is a convenience; the sale itself does not depend on it.
    } finally {
      this.pendingLoading = false;
    }
  }

  private readonly onShown = () => {
    if (document.visibilityState === 'visible') void this.loadPending();
  };

  private readonly onVisible = () => {
    if (document.visibilityState === 'visible') void this.poll();
  };
  private polling = false;
  /** True while the shown error came from a poll: the next good poll clears it. */
  private pollFailed = false;

  private startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.poll();
    }, POLL_MS);
    // Back from the payment tab: check at once instead of waiting for the next tick.
    document.addEventListener('visibilitychange', this.onVisible);
  }

  private stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisible);
  }

  /** One status check (the timer and a return to the tab call it; never two in flight): paid ends the sale. */
  async poll() {
    const number = this.orderNumber();
    if (number === null || this.polling) return;
    this.polling = true;
    try {
      const { status } = await this.api.status(number);
      // Another order was opened meanwhile (a new sale, a retry from the pending list): this answer is not for it.
      if (this.orderNumber() !== number) return;
      if (this.pollFailed) {
        this.pollFailed = false;
        this.error.set('');
      }
      if (status === 'pending_payment') return;
      this.stopPolling();
      this.payment.set(FAILED.has(status) ? 'failed' : CLOSED.has(status) ? 'closed' : 'paid');
      void this.loadPending();
    } catch (e) {
      if (this.orderNumber() !== number) return;
      this.pollFailed = true;
      this.error.set(storeErrorMessage(e));
    } finally {
      this.polling = false;
    }
  }
}
