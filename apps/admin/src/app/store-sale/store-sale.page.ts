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
import { errorCode, storeErrorMessage } from '../core/errors';
import { StoreOrdersApi } from '../core/store-orders.api';
import { ConfirmDialog } from '../orders/confirm-dialog';
import { CustomerStep } from './customer-step';
import { DeliveryStep } from './delivery-step';
import { PendingOrders } from './pending-orders';
import { ProductPicker } from './product-picker';
import { STEPS, STEP_LABELS, canEnter, stepAfterError, type DeliveryChoice, type SaleStep } from './steps';

/** Order statuses where the payment did not go through: the seller may try again. */
const FAILED = new Set(['payment_failed', 'expired', 'cancelled']);

type PaymentState = 'waiting' | 'paid' | 'failed';

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
  readonly payment = signal<PaymentState>('waiting');
  readonly pending = signal<StorePendingOrder[]>([]);
  protected readonly payUrl = signal<string | null>(null);
  protected readonly acceptTerms = signal(false);
  protected readonly marketing = signal(false);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly loaded = signal(false);

  protected readonly state = computed(() => ({
    cart: this.cart(),
    delivery: this.delivery(),
    orderNumber: this.orderNumber(),
  }));
  protected readonly discount = computed(() => this.cart()?.discount?.amount ?? 0);
  protected readonly total = computed(() => {
    const cart = this.cart();
    return cart ? cart.subtotal - this.discount() + (this.delivery()?.shippingTotal ?? 0) : 0;
  });

  constructor() {
    inject(DestroyRef).onDestroy(() => this.stopPolling());
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
      this.cart.set(await this.api.cart());
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

  async newSale() {
    this.stopPolling();
    this.busy.set(true);
    try {
      this.cart.set(await this.api.startSale());
      this.delivery.set(null);
      this.orderNumber.set(null);
      this.payUrl.set(null);
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
      this.openPayment(created.redirectUrl);
      this.beginStatus();
      void this.loadPending();
    } catch (e) {
      const body = e instanceof HttpErrorResponse ? (e.error as { code?: string; number?: number } | null) : null;
      if (body?.code === 'order_pending' && typeof body.number === 'number') {
        // The sale already has an order: show it, with "נסה שוב" for a new payment page.
        this.orderNumber.set(body.number);
        this.payUrl.set(null);
        this.beginStatus();
        this.error.set(storeErrorMessage(e));
      } else {
        this.error.set(storeErrorMessage(e));
        this.onFailed(e);
        if (errorCode(e) === 'price_changed') await this.refreshCart();
      }
    } finally {
      this.busy.set(false);
    }
  }

  private openPayment(url: string) {
    this.payUrl.set(url);
    // A blocked pop-up leaves the link on screen.
    window.open(url, '_blank');
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
    const sure = await new Promise<boolean>((resolve) =>
      this.dialog
        .open(ConfirmDialog, { data: { message: `לבטל את הזמנה ${number}? הלקוח לא יחויב.` } })
        .afterClosed()
        .subscribe((v) => resolve(v === true)),
    );
    if (!sure) return;
    try {
      await this.api.cancel(number);
      if (this.orderNumber() === number) {
        this.stopPolling();
        this.payment.set('failed');
      }
      await this.loadPending();
    } catch (e) {
      this.error.set(storeErrorMessage(e));
    }
  }

  async loadPending() {
    try {
      this.pending.set(await this.api.pending());
    } catch {
      // The list is a convenience; the sale itself does not depend on it.
    }
  }

  private startPolling() {
    this.stopPolling();
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible') void this.poll();
    }, POLL_MS);
  }

  private stopPolling() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One status check (also called by the timer): paid ends the sale, failed or expired offers a retry. */
  async poll() {
    const number = this.orderNumber();
    if (number === null) return;
    try {
      const { status } = await this.api.status(number);
      if (status === 'pending_payment') return;
      this.stopPolling();
      this.payment.set(FAILED.has(status) ? 'failed' : 'paid');
      void this.loadPending();
    } catch (e) {
      this.error.set(storeErrorMessage(e));
    }
  }
}
