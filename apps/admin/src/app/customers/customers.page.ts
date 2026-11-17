import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { ADMIN_CUSTOMERS_QUERY_MAX, CUSTOMER_ORIGIN_LABELS_HE, type CustomerPage } from '@hg/models';
import { CustomersApi } from '../core/customers.api';
import { errorMessage } from '../core/errors';
import { israelDateTime } from '../core/israel-time';

/**
 * "לקוחות" (spec §4.5, CLB-09, permission customers.view): the accounts, newest first, 30 per page. The search (name,
 * phone, e-mail or order number) and the page live in the URL (`?q=&page=`), bound to the inputs by the router, so Back
 * keeps them. Only the answer to the latest request is shown.
 */
@Component({
  selector: 'hga-customers-page',
  imports: [RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './customers.page.html',
  styleUrl: './customers.page.scss',
})
export class CustomersPage {
  private readonly api = inject(CustomersApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Increases with every request; a slower, older answer finds it changed and is dropped. */
  private requestSeq = 0;

  readonly qParam = input<string | undefined>(undefined, { alias: 'q' });
  readonly pageParam = input<string | undefined>(undefined, { alias: 'page' });

  protected readonly originLabels = CUSTOMER_ORIGIN_LABELS_HE;
  protected readonly queryMax = ADMIN_CUSTOMERS_QUERY_MAX;
  protected readonly dateTime = israelDateTime;
  protected readonly q = computed(() => (this.qParam() ?? '').trim().slice(0, ADMIN_CUSTOMERS_QUERY_MAX));
  protected readonly page = computed(() => {
    const n = Number(this.pageParam());
    return Number.isInteger(n) && n >= 1 && n <= 999_999 ? n : 1;
  });
  /** What is typed in the search field (applied on submit). */
  protected readonly text = signal('');
  protected readonly data = signal<CustomerPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  constructor() {
    // The field shows the search of the URL (Back, a shared link).
    effect(() => this.text.set(this.q()));
    effect(() => void this.load(this.q(), this.page()));
  }

  protected search(event: Event) {
    event.preventDefault();
    this.navigate(this.text().trim(), 1);
  }

  protected goTo(page: number) {
    this.navigate(this.q(), page);
  }

  protected retry() {
    void this.load(this.q(), this.page());
  }

  protected pages(d: CustomerPage): number {
    return Math.max(1, Math.ceil(d.total / d.pageSize));
  }

  private navigate(q: string, page: number) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { q: q || null, page: page > 1 ? page : null },
    });
  }

  private async load(q: string, page: number) {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.list(q, page);
      if (seq === this.requestSeq) this.data.set(result);
    } catch (e) {
      if (seq !== this.requestSeq) return;
      // Never leave the rows of another search under this one.
      this.data.set(null);
      this.error.set(errorMessage(e));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
