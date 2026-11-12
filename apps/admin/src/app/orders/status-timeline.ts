import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { DatePipe } from '@angular/common';
import {
  ORDER_STATUS_LABELS_HE,
  type AdminOrderStatusEvent,
  type AdminRefund,
  type OrderStatus,
  type RefundStatus,
} from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';

export const REFUND_STATUS_LABELS_HE: Record<RefundStatus, string> = {
  pending: 'בתהליך',
  succeeded: 'בוצע',
  failed: 'נכשל',
};

interface Entry {
  key: string;
  at: string;
  kind: 'status' | 'refund';
  status?: OrderStatus;
  refund?: AdminRefund;
  actor: string;
  note: string | null;
}

/** Status changes and refunds of one order, merged by time (spec §4.4). Refunds are not status events. */
@Component({
  selector: 'hga-status-timeline',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ol class="timeline">
      @for (e of entries(); track e.key) {
        <li class="entry" [attr.data-kind]="e.kind">
          @if (e.refund; as r) {
            <strong>החזר כספי {{ formatPrice(r.amount) }}</strong>
            <span class="badge" [attr.data-status]="r.status">{{ refundLabels[r.status] }}</span>
            @if (r.status === 'failed' && canRetry()) {
              <button type="button" class="retry" (click)="retry.emit(r.id)">נסה שוב</button>
            }
          } @else {
            <strong>{{ statusLabels[e.status!] }}</strong>
          }
          <span class="meta">{{ e.actor }} · {{ e.at | date: 'd.M.yyyy HH:mm' }}</span>
          @if (e.note) {
            <span class="note">{{ e.note }}</span>
          }
        </li>
      } @empty {
        <li class="meta">אין אירועים להצגה.</li>
      }
    </ol>
  `,
  styles: `
    .timeline {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-3);
    }

    .entry {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: var(--space-1) var(--space-3);
      padding-block-end: var(--space-3);
      border-block-end: var(--border-width) solid var(--color-border);
      overflow-wrap: anywhere;
    }

    .meta,
    .note {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .meta,
    .note {
      flex-basis: 100%;
    }

    .badge {
      padding: var(--badge-padding-block) var(--badge-padding-inline);
      font-size: var(--font-small);
      border-radius: var(--radius-pill);
      background: var(--color-surface-alt);
    }

    .badge[data-status='succeeded'] {
      color: var(--color-success);
      background: var(--color-success-soft);
    }

    .badge[data-status='failed'] {
      color: var(--color-danger);
      background: var(--color-danger-soft);
    }
  `,
})
export class StatusTimeline {
  readonly events = input.required<AdminOrderStatusEvent[]>();
  readonly refunds = input.required<AdminRefund[]>();
  /** The signed-in admin: the only staff name the client knows. */
  readonly currentAdmin = input<{ id: number; name: string } | null>(null);
  /** Staff with `orders.cancel` may retry a failed refund. */
  readonly canRetry = input(false);
  /** The id of the failed refund to retry. */
  readonly retry = output<string>();

  protected readonly statusLabels = ORDER_STATUS_LABELS_HE;
  protected readonly refundLabels = REFUND_STATUS_LABELS_HE;
  protected readonly formatPrice = formatPrice;

  protected readonly entries = computed<Entry[]>(() => {
    const status: Entry[] = this.events().map((e, i) => ({
      key: `s${i}`,
      at: e.createdAt,
      kind: 'status',
      status: e.toStatus,
      actor: this.actor(e.actorType, e.actorAdminId),
      note: e.note,
    }));
    const refunds: Entry[] = this.refunds().map((r) => ({
      key: `r${r.id}`,
      at: r.createdAt,
      kind: 'refund',
      refund: r,
      actor: this.actor(r.adminUserId === null ? 'system' : 'admin', r.adminUserId),
      note: r.reason + (r.status === 'failed' && r.error ? ` (${r.error})` : ''),
    }));
    return [...status, ...refunds].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  });

  private actor(type: AdminOrderStatusEvent['actorType'], adminId: number | null): string {
    if (type === 'customer') return 'הלקוח';
    if (type === 'system') return 'המערכת';
    const me = this.currentAdmin();
    return me && adminId === me.id ? me.name : 'צוות החנות';
  }
}
