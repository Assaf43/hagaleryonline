import { ChangeDetectionStrategy, Component, computed, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import {
  RETURN_REASON_LABELS_HE,
  SUPPORT_TICKET_STATUS_LABELS_HE,
  SUPPORT_TICKET_STATUSES,
  SUPPORT_TICKET_TYPE_LABELS_HE,
  TICKET_NOTE_LIMITS,
  type AdminTicketDetail,
  type SupportTicketStatus,
} from '@hg/models';
import { AuthService } from '../core/auth.service';
import { errorMessage, NOTE_MESSAGE } from '../core/errors';
import { SupportApi } from '../core/support.api';
import { israelDateTime } from '../promotions/israel-time';

/**
 * One support ticket (spec §7.2, permission support.manage): type and status, the sender's contact, the order link
 * (the refund action lives on the order page; the ticket never moves money), the lines, the photos, the internal
 * notes and the status select. Photos come from the private admin endpoint with the session cookie. The route's
 * `:number` is bound to the input.
 */
@Component({
  selector: 'hga-ticket-page',
  imports: [RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './ticket.page.html',
  styleUrl: './ticket.page.scss',
})
export class TicketPage {
  private readonly api = inject(SupportApi);
  private readonly auth = inject(AuthService);
  /** Increases with every load (the route may change the number): only the latest answer is shown. */
  private requestSeq = 0;

  readonly number = input.required<string>();

  protected readonly typeLabels = SUPPORT_TICKET_TYPE_LABELS_HE;
  protected readonly statusLabels = SUPPORT_TICKET_STATUS_LABELS_HE;
  protected readonly statuses = SUPPORT_TICKET_STATUSES;
  protected readonly reasonLabels = RETURN_REASON_LABELS_HE;
  protected readonly noteMax = TICKET_NOTE_LIMITS.max;
  protected readonly dateTime = israelDateTime;
  protected readonly ticket = signal<AdminTicketDetail | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal('');
  protected readonly statusBusy = signal(false);
  protected readonly statusError = signal('');
  protected readonly noteText = signal('');
  protected readonly noteBusy = signal(false);
  protected readonly noteError = signal('');
  /** The order page needs orders.view; without it the order number is shown as text. */
  protected readonly canSeeOrders = computed(() => this.auth.can('orders.view'));

  constructor() {
    effect(() => void this.load(this.number()));
  }

  protected photoUrl(t: AdminTicketDetail, attachmentId: number): string {
    return this.api.photoUrl(t.number, attachmentId);
  }

  protected photoAlt(index: number, total: number): string {
    return `תמונה ${index + 1} מתוך ${total} שצירף הלקוח`;
  }

  protected async changeStatus(t: AdminTicketDetail, select: HTMLSelectElement) {
    const status = select.value as SupportTicketStatus;
    if (status === t.status || this.statusBusy()) return;
    this.statusBusy.set(true);
    this.statusError.set('');
    try {
      this.ticket.set(await this.api.setStatus(t.number, status));
      void this.api.refreshNewCount();
    } catch (e) {
      select.value = t.status;
      this.statusError.set(errorMessage(e));
    } finally {
      this.statusBusy.set(false);
    }
  }

  protected async addNote(t: AdminTicketDetail, event: Event) {
    event.preventDefault();
    const body = this.noteText().trim();
    if (!body || body.length > this.noteMax) {
      this.noteError.set(NOTE_MESSAGE);
      return;
    }
    if (this.noteBusy()) return;
    this.noteBusy.set(true);
    this.noteError.set('');
    try {
      this.ticket.set(await this.api.addNote(t.number, body));
      this.noteText.set('');
    } catch (e) {
      this.noteError.set(errorMessage(e));
    } finally {
      this.noteBusy.set(false);
    }
  }

  private async load(number: string) {
    const seq = ++this.requestSeq;
    this.ticket.set(null);
    this.error.set('');
    this.loading.set(true);
    try {
      const ticket = await this.api.detail(number);
      if (seq === this.requestSeq) this.ticket.set(ticket);
    } catch (e) {
      if (seq === this.requestSeq)
        this.error.set((e as { status?: number }).status === 404 ? 'הפנייה לא נמצאה.' : errorMessage(e));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
