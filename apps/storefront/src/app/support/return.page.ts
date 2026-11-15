import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import {
  RETURN_REASONS,
  RETURN_REASON_LABELS_HE,
  SUPPORT_FIELD_MESSAGES_HE,
  SUPPORT_LIMITS,
  SUPPORT_RETURN_NOT_DELIVERED_HE,
  SUPPORT_RETURN_WINDOW_PASSED_HE,
  type OrderLine,
  type ReturnReason,
  type ReturnRequestBody,
} from '@hg/models';
import { formatDate } from '../core/format';
import { PageMeta } from '../core/page-meta';
import { CustomerStore } from '../account/customer.store';
import { returnOpen } from '../order/return-window';
import { OrderStep } from './order-step';
import { SupportApi, supportErrorMessage, supportFailure, supportSuccessText, type SupportOrder } from './support.api';

type ReturnField = 'items' | 'type' | 'reasonCode' | 'note';

const IDS = { items: 'rt-line-0', type: 'rt-type-return', reasonCode: 'rt-reason', note: 'rt-note' } as const;

/**
 * Return or exchange `/returns` (spec §7.1, SRV-02). Step 1 finds the order (`OrderStep`; `?order=<number>` from the
 * order page or the account fills the number). Only a delivered order inside the return window gets the form: lines
 * with quantities, return or exchange, a reason from the closed list and an optional note. The server decides
 * (409 `not_delivered` / `return_window_passed` show inline). `noindex`, never in the sitemap.
 */
@Component({
  selector: 'hg-return-page',
  imports: [OrderStep],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './return.page.html',
  styleUrl: './support.scss',
})
export class ReturnPage {
  /** The order number from the link (`?order=`). */
  readonly order = input<string | undefined>(undefined);

  private readonly api = inject(SupportApi);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly store = inject(CustomerStore);
  /** Known only in the browser after the session loads; the server renders the signed-out text. */
  protected readonly signedIn = computed(() => this.store.me() !== null);

  protected readonly ids = IDS;
  protected readonly reasons = RETURN_REASONS.map((code) => ({ code, label: RETURN_REASON_LABELS_HE[code] }));
  protected readonly noteMax = SUPPORT_LIMITS.noteMax;
  protected readonly found = signal<SupportOrder | null>(null);
  /** Chosen quantity per order line id. */
  protected readonly picked = signal<Record<number, number>>({});
  protected readonly type = signal<'return' | 'exchange'>('return');
  protected readonly reason = signal<ReturnReason | ''>('');
  protected readonly note = signal('');
  protected readonly website = signal('');
  protected readonly errors = signal<Partial<Record<ReturnField, string>>>({});
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly done = signal('');

  /** Why the form is not offered for the order found, or `''`. */
  protected readonly blocked = computed(() => {
    const o = this.found()?.order;
    if (!o) return '';
    if (o.status !== 'delivered') return SUPPORT_RETURN_NOT_DELIVERED_HE;
    if (!returnOpen(o)) return SUPPORT_RETURN_WINDOW_PASSED_HE;
    return '';
  });
  protected readonly deadline = computed(() => {
    const until = this.found()?.order.returnUntil;
    return until ? formatDate(until) : '';
  });

  constructor() {
    inject(PageMeta).set({
      title: 'החזרה או החלפה',
      description: 'בקשת החזרה או החלפה להזמנה שסופקה',
      path: '/returns',
      noindex: true,
    });
  }

  protected orderFound(result: SupportOrder | null): void {
    this.found.set(result);
    this.picked.set({});
    this.errors.set({});
    this.formError.set('');
  }

  protected isPicked(line: OrderLine): boolean {
    return this.picked()[line.orderItemId] !== undefined;
  }

  protected quantityOf(line: OrderLine): number {
    return this.picked()[line.orderItemId] ?? 1;
  }

  protected range(line: OrderLine): number[] {
    return Array.from({ length: line.quantity }, (_, i) => i + 1);
  }

  protected toggle(line: OrderLine, event: Event): void {
    const on = (event.target as HTMLInputElement).checked;
    this.picked.update((p) => {
      const next = { ...p };
      if (on) next[line.orderItemId] = line.quantity;
      else delete next[line.orderItemId];
      return next;
    });
    this.clear('items');
  }

  protected setQuantity(line: OrderLine, event: Event): void {
    const quantity = Number((event.target as HTMLSelectElement).value);
    this.picked.update((p) => ({ ...p, [line.orderItemId]: quantity }));
  }

  protected setType(value: 'return' | 'exchange'): void {
    this.type.set(value);
  }

  protected setReason(event: Event): void {
    this.reason.set((event.target as HTMLSelectElement).value as ReturnReason | '');
    this.clear('reasonCode');
  }

  protected setNote(event: Event): void {
    this.note.set((event.target as HTMLTextAreaElement).value);
    this.clear('note');
  }

  protected setWebsite(event: Event): void {
    this.website.set((event.target as HTMLInputElement).value);
  }

  private clear(field: ReturnField): void {
    this.formError.set('');
    if (this.errors()[field]) this.errors.update((e) => ({ ...e, [field]: undefined }));
  }

  private focus(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    const found = this.found();
    if (this.busy() || !found || this.blocked()) return;
    this.formError.set('');
    const errors: Partial<Record<ReturnField, string>> = {};
    const items = found.order.lines
      .filter((l) => this.isPicked(l))
      .map((l) => ({ orderItemId: l.orderItemId, quantity: this.quantityOf(l) }));
    if (!items.length) errors.items = SUPPORT_FIELD_MESSAGES_HE.items;
    if (!this.reason()) errors.reasonCode = SUPPORT_FIELD_MESSAGES_HE.reasonCode;
    if (this.note().trim().length > SUPPORT_LIMITS.noteMax) errors.note = SUPPORT_FIELD_MESSAGES_HE.note;
    this.errors.set(errors);
    const first = (['items', 'reasonCode', 'note'] as const).find((f) => errors[f]);
    if (first) {
      this.focus(`#${IDS[first]}`);
      return;
    }
    const body: ReturnRequestBody = {
      order: found.ref,
      type: this.type(),
      items,
      reasonCode: this.reason() as ReturnReason,
      website: this.website(),
    };
    const note = this.note().trim();
    if (note) body.note = note;
    this.busy.set(true);
    try {
      const created = await this.api.returns(body);
      this.done.set(supportSuccessText(created.ticketNumber));
      this.focus('#rt-success');
    } catch (error) {
      const failure = supportFailure(error);
      const message = supportErrorMessage(failure, 'return');
      const field = (failure.field ?? '').split('.')[0];
      if (
        failure.code === 'invalid_field' &&
        (field === 'items' || field === 'type' || field === 'reasonCode' || field === 'note')
      ) {
        this.errors.set({ [field]: message });
        this.focus(`#${IDS[field]}`);
      } else {
        this.formError.set(message);
      }
    } finally {
      this.busy.set(false);
    }
  }
}
