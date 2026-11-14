import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ACCOUNT_ORDERS_PAGE_SIZE, type AccountOrdersPage } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { formatDate, formatPrice } from '../core/format';
import { AccountNav } from './account-nav';
import { AccountApi } from './account.api';
import { CustomerStore } from './customer.store';

/**
 * `/account/orders` (ACC-03): the customer's orders, newest first, a page at a time. Only orders placed while signed
 * in appear (decision 77). Read in the browser after the session is known; the server renders the heading only.
 */
@Component({
  selector: 'hg-account-orders-page',
  imports: [AccountNav, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './orders.page.html',
  styleUrl: './account.scss',
})
export class OrdersPage {
  private readonly api = inject(AccountApi);
  private readonly store = inject(CustomerStore);

  protected readonly state = signal<'loading' | 'ready' | 'error'>('loading');
  protected readonly data = signal<AccountOrdersPage | null>(null);
  protected readonly page = signal(1);
  protected readonly pages = computed(() => {
    const d = this.data();
    return d ? Math.max(1, Math.ceil(d.total / (d.pageSize || ACCOUNT_ORDERS_PAGE_SIZE))) : 1;
  });
  protected readonly price = formatPrice;
  protected readonly date = formatDate;

  constructor() {
    inject(PageMeta).set({
      title: 'ההזמנות שלי',
      description: 'ההזמנות בחשבון שלי',
      path: '/account/orders',
      noindex: true,
    });
    if (isPlatformBrowser(inject(PLATFORM_ID))) void this.load(1);
  }

  protected async load(page: number): Promise<void> {
    this.state.set('loading');
    await this.store.load();
    try {
      this.data.set(await this.api.orders(page));
      this.page.set(page);
      this.state.set('ready');
    } catch (error) {
      if (this.store.unauthorized(error)) return;
      this.state.set('error');
    }
  }
}
