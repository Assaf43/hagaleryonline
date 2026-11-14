import {
  ChangeDetectionStrategy,
  Component,
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
import { RouterLink } from '@angular/router';
import type { OrderView } from '@hg/models';
import { ORDER_STATUS_TITLES, OrderDetail } from '../order/order-detail';
import { PageMeta } from '../core/page-meta';
import { formatPrice } from '../core/format';
import { SUPPORT_CONTACT } from '../core/support-contact';
import { AccountNav } from './account-nav';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import { CustomerStore } from './customer.store';

/**
 * `/account/orders/:number` (ACC-03): the order view of Task 5 (`OrderDetail`) for an order of this account, with the
 * account's own cancel of an unpaid order (`POST /api/account/orders/:number/cancel`). There is no account retry of a
 * payment (it needs the order token), so where retrying is possible the page points to the link in the order e-mail.
 * Another account's order reads as not found.
 */
@Component({
  selector: 'hg-account-order-detail-page',
  imports: [AccountNav, OrderDetail, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-detail.page.html',
  styleUrl: './account.scss',
})
export class OrderDetailPage {
  readonly number = input.required<string>();

  private readonly api = inject(AccountApi);
  private readonly store = inject(CustomerStore);
  private readonly meta = inject(PageMeta);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly cancelDialog = viewChild<ElementRef<HTMLDialogElement>>('cancelDialog');

  protected readonly order = signal<OrderView | null>(null);
  protected readonly state = signal<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  protected readonly cancelling = signal(false);
  protected readonly actionError = signal('');
  protected readonly support = SUPPORT_CONTACT;
  protected readonly price = formatPrice;
  /** Bumped on every load, so an answer for an older number is dropped. */
  private generation = 0;

  protected readonly title = computed(() => {
    const o = this.order();
    return o ? (ORDER_STATUS_TITLES[o.status] ?? o.statusLabelHe) : '';
  });
  /** Paid orders the customer cannot cancel online are sent to customer service. */
  protected readonly contactSupport = computed(() => {
    const s = this.order()?.status;
    return s === 'paid' || s === 'processing' || s === 'delivery_scheduled' || s === 'shipped';
  });

  constructor() {
    effect(() => {
      const number = this.number();
      untracked(() => {
        this.meta.set({
          title: 'פרטי ההזמנה',
          description: 'מצב ההזמנה ופרטיה',
          path: `/account/orders/${encodeURIComponent(number)}`,
          noindex: true,
        });
        if (this.browser) void this.load(number, true);
      });
    });
  }

  /** `first`: show the loading state; otherwise the order stays on screen while it is read again. */
  private async load(number: string, first: boolean): Promise<void> {
    const generation = ++this.generation;
    if (first) {
      this.order.set(null);
      this.state.set('loading');
    }
    await this.store.load();
    try {
      const view = await this.api.order(number);
      if (generation !== this.generation) return;
      this.order.set(view);
      this.state.set('ready');
    } catch (error) {
      if (generation !== this.generation) return;
      if (this.store.unauthorized(error)) return;
      if (this.order()) return;
      this.state.set(accountFailure(error).status === 404 ? 'not_found' : 'error');
    }
  }

  protected reload(): void {
    void this.load(this.number(), true);
  }

  protected openCancel(): void {
    this.actionError.set('');
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
      const view = await this.api.cancelOrder(this.number());
      this.order.set(view);
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      const failure = accountFailure(error);
      if (failure.status === 409) {
        // Just paid or otherwise no longer cancellable: say so and show the real state.
        this.actionError.set('אי אפשר לבטל את ההזמנה כעת');
        void this.load(this.number(), false);
      } else {
        this.actionError.set(accountErrorMessage(failure));
      }
    } finally {
      this.cancelling.set(false);
      this.closeCancel();
    }
  }
}
