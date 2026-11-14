import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import {
  SUPPORT_TICKET_STATUS_LABELS_HE,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_TYPE_LABELS_HE,
  SUPPORT_TICKET_TYPES,
  type AdminTicketPage,
  type SupportTicketStatus,
  type SupportTicketType,
} from '@hg/models';
import { errorMessage } from '../core/errors';
import { SupportApi, type TicketFilter } from '../core/support.api';
import { israelDateTime } from '../promotions/israel-time';

interface Filter<T> {
  value: T | null;
  label: string;
}

const TYPE_FILTERS: Filter<SupportTicketType>[] = [
  { value: null, label: 'הכול' },
  ...SUPPORT_TICKET_TYPES.map((value) => ({ value, label: SUPPORT_TICKET_TYPE_LABELS_HE[value] })),
];
const STATUS_FILTERS: Filter<SupportTicketStatus>[] = [
  { value: null, label: 'הכול' },
  ...SUPPORT_TICKET_STATUSES.map((value) => ({ value, label: SUPPORT_TICKET_STATUS_LABELS_HE[value] })),
];

/** "תמונה אחת" / "N תמונות". */
export function photosLabel(count: number): string {
  return count === 1 ? 'תמונה אחת' : `${count} תמונות`;
}

const known = <T extends string>(list: readonly T[], value: string | undefined): T | null =>
  value !== undefined && (list as readonly string[]).includes(value) ? (value as T) : null;

/**
 * "פניות" (spec §7.2, permission support.manage): the tickets newest first, 30 per page, filtered by type and status.
 * The filters and the page live in the URL (`?type=&status=&page=`), bound to the inputs by the router, so Back keeps
 * them; unknown values in the URL mean "all". Only the answer to the latest request is shown.
 */
@Component({
  selector: 'hga-inbox-page',
  imports: [RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './inbox.page.html',
  styleUrl: './inbox.page.scss',
})
export class InboxPage {
  private readonly api = inject(SupportApi);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  /** Increases with every request; a slower, older answer finds it changed and is dropped. */
  private requestSeq = 0;

  readonly typeParam = input<string | undefined>(undefined, { alias: 'type' });
  readonly statusParam = input<string | undefined>(undefined, { alias: 'status' });
  readonly pageParam = input<string | undefined>(undefined, { alias: 'page' });

  protected readonly typeFilters = TYPE_FILTERS;
  protected readonly statusFilters = STATUS_FILTERS;
  protected readonly typeLabels = SUPPORT_TICKET_TYPE_LABELS_HE;
  protected readonly statusLabels = SUPPORT_TICKET_STATUS_LABELS_HE;
  protected readonly dateTime = israelDateTime;
  protected readonly photosLabel = photosLabel;
  protected readonly type = computed(() => known(SUPPORT_TICKET_TYPES, this.typeParam()));
  protected readonly status = computed(() => known(SUPPORT_TICKET_STATUSES, this.statusParam()));
  protected readonly page = computed(() => {
    const n = Number(this.pageParam());
    return Number.isInteger(n) && n >= 1 && n <= 999_999 ? n : 1;
  });
  private readonly filter = computed<TicketFilter>(() => ({
    type: this.type(),
    status: this.status(),
    page: this.page(),
  }));
  protected readonly data = signal<AdminTicketPage | null>(null);
  protected readonly loading = signal(false);
  protected readonly error = signal('');

  constructor() {
    effect(() => void this.load(this.filter()));
  }

  protected filterType(type: SupportTicketType | null) {
    this.navigate({ type, status: this.status(), page: 1 });
  }

  protected filterStatus(status: SupportTicketStatus | null) {
    this.navigate({ type: this.type(), status, page: 1 });
  }

  protected goTo(page: number) {
    this.navigate({ type: this.type(), status: this.status(), page });
  }

  protected retry() {
    void this.load(this.filter());
  }

  protected pages(d: AdminTicketPage): number {
    return Math.max(1, Math.ceil(d.total / d.pageSize));
  }

  private navigate(state: TicketFilter) {
    void this.router.navigate([], {
      relativeTo: this.route,
      queryParams: { type: state.type, status: state.status, page: state.page > 1 ? state.page : null },
    });
  }

  private async load(filter: TicketFilter) {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.list(filter);
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
