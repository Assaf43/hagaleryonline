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
  viewChild,
  type ElementRef,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import { ORDER_STATUS_TITLES, OrderDetail } from './order-detail';
import type { OrderView } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { CustomerStore } from '../account/customer.store';
import { JoinContact, type JoinContactData } from '../account/join-contact';
import { SignUpDraft } from '../account/sign-up-draft';
import { formatPrice } from '../core/format';
import { PageMeta } from '../core/page-meta';
import { SUPPORT_CONTACT } from '../core/support-contact';
import { CheckoutApi, ExternalNavigation, apiErrorCode, checkoutErrorMessage } from '../checkout/checkout.api';
import { returnOpen } from './return-window';

/** Statuses of an order the customer has paid (a join offer fits the end of a purchase, not a payment problem). */
const PURCHASED = new Set(['paid', 'processing', 'delivery_scheduled', 'shipped', 'delivered']);

const POLL_MS = 3000;
/** A pending order is polled for at most this long; then the customer can check again by hand. */
const POLL_FOR_MS = 60_000;

/**
 * Order confirmation `/order/:number?t=<token>` (spec §5.5, CHK-04): status, lines, address, method, totals and
 * delivery estimate. The token is the only key, so the order is read only in the browser (the server renders a
 * shell). A pending order is re-read every 3 s for up to a minute; a paid one refreshes the cart (the webhook
 * emptied it); a failed or expired one offers "נסו לשלם שוב" while the API allows it, otherwise the cart.
 */
@Component({
  selector: 'hg-order-page',
  imports: [OrderDetail, RouterLink],
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
  private readonly customer = inject(CustomerStore);
  private readonly joinContact = inject(JoinContact);
  private readonly draft = inject(SignUpDraft);
  private readonly router = inject(Router);

  protected readonly order = signal<OrderView | null>(null);
  /** "החזרה או החלפה" only until the return deadline; the damaged-product link stays. */
  protected readonly returnOpen = (o: OrderView): boolean => returnOpen(o);
  protected readonly state = signal<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  /** Polling stopped while still pending. */
  protected readonly pollingStopped = signal(false);
  protected readonly retrying = signal(false);
  /** Message of the last retry or cancel attempt (one alert for both). */
  protected readonly retryError = signal('');
  protected readonly cancelling = signal(false);
  protected readonly support = SUPPORT_CONTACT;
  private readonly cancelDialog = viewChild<ElementRef<HTMLDialogElement>>('cancelDialog');

  protected readonly title = computed(() => {
    const o = this.order();
    return o ? (ORDER_STATUS_TITLES[o.status] ?? o.statusLabelHe) : '';
  });
  /** Paid orders the customer cannot cancel online: they are sent to customer service. */
  protected readonly contactSupport = computed(() => {
    const s = this.order()?.status;
    return s === 'paid' || s === 'processing' || s === 'delivery_scheduled' || s === 'shipped';
  });
  /** The agreed slot matters only while the delivery is ahead (never on a cancelled or delivered order). */
  protected readonly showSlot = computed(() => {
    const s = this.order()?.status;
    return s === 'delivery_scheduled' || s === 'shipped';
  });
  /** "9.11.2026" from the Israel calendar date as given (no timezone shift). */
  protected readonly slotDate = computed(() => {
    const d = this.order()?.deliverySlot?.date;
    const m = d ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(d) : null;
    return m ? `${Number(m[3])}.${Number(m[2])}.${m[1]}` : (d ?? '');
  });
  protected readonly failed = computed(() => {
    const s = this.order()?.status;
    return s === 'payment_failed' || s === 'expired';
  });
  protected readonly price = formatPrice;

  /** The active welcome offer's label, read only for a guest viewer of a paid guest order; null hides the join box. */
  private readonly welcomeLabel = signal<string | null>(null);
  private joinChecked = false;
  /** The checkout contact, taken out of the tab's storage when the box is shown and kept in memory for the click. */
  private joinContactData: JoinContactData | null = null;
  /**
   * The invitation: a guest order (no account, `guestOrder`), a guest viewer (the session was read and nobody is
   * signed in) and an active welcome offer.
   */
  protected readonly joinOffer = computed(() =>
    this.order()?.guestOrder && this.customer.ready() && !this.customer.me() ? this.welcomeLabel() : null,
  );

  /** The document opens through the API with the order token, like the page itself (spec §5.4). */
  protected readonly documentUrl = (id: string): string => {
    const number = encodeURIComponent(this.number());
    return `/api/orders/${number}/invoices/${encodeURIComponent(id)}?t=${encodeURIComponent(this.t() ?? '')}`;
  };

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
    if (PURCHASED.has(view.status)) void this.checkJoin(view.guestOrder);
    if (view.status === 'pending_payment') this.schedule(number, token, generation);
    if (view.status === 'paid' && !this.cartRefreshed) {
      this.cartRefreshed = true;
      void this.cart.load();
    }
  }

  /**
   * Once per page, for a guest order only: the session, then (for a guest viewer) the welcome offer. Nothing is linked
   * to this order (decision 77). The stored checkout contact leaves the tab's storage whatever the outcome: kept in
   * memory when the box is shown (for the click), dropped otherwise, so a later order page never prefills it.
   */
  private async checkJoin(guestOrder: boolean): Promise<void> {
    if (this.joinChecked) return;
    this.joinChecked = true;
    if (!guestOrder) {
      this.joinContact.clear();
      return;
    }
    await this.customer.load();
    let label: string | null = null;
    if (!this.customer.me()) {
      try {
        label = (await this.api.welcome())?.labelHe ?? null;
      } catch {
        // No offer: no box.
      }
    }
    this.joinContactData = label ? this.joinContact.read() : null;
    this.joinContact.clear();
    this.welcomeLabel.set(label);
  }

  /** "הצטרפות": hands the checkout contact to the sign-up page in memory (never in the URL) and goes there. */
  protected join(event: Event): void {
    event.preventDefault();
    const c = this.joinContactData;
    this.joinContactData = null;
    this.draft.set({
      fullName: c?.fullName,
      phone: c?.phone ?? null,
      email: c?.email ?? null,
      signUpToken: null,
      verified: { phone: null, email: null },
    });
    void this.router.navigateByUrl('/account/sign-up');
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

  protected openCancel(): void {
    this.retryError.set('');
    this.cancelDialog()?.nativeElement.showModal();
  }

  protected closeCancel(): void {
    const dialog = this.cancelDialog()?.nativeElement;
    if (dialog?.open) dialog.close();
  }

  protected async confirmCancel(): Promise<void> {
    if (this.cancelling()) return;
    this.cancelling.set(true);
    try {
      await this.api.cancelOrder(this.number(), this.t() ?? '');
    } catch (error) {
      this.cancelling.set(false);
      this.closeCancel();
      if (error instanceof HttpErrorResponse && error.status === 409) {
        // Just paid or otherwise no longer cancellable: say so and show the real state.
        this.reload();
        this.retryError.set('אי אפשר לבטל את ההזמנה כעת');
      } else {
        this.retryError.set(checkoutErrorMessage(apiErrorCode(error)));
      }
      return;
    }
    this.cancelling.set(false);
    this.closeCancel();
    this.reload();
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
      // A 409 (promotion ended, superseded, not retryable, stock gone) means this order cannot be paid again:
      // offer the cart instead of a button that would only be refused again. Network errors keep the button.
      if (error instanceof HttpErrorResponse && error.status === 409)
        this.order.update((o) => (o ? { ...o, canRetryPayment: false } : o));
    }
  }
}
