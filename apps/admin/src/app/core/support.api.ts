import { Injectable, inject, signal } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminTicketDetail,
  AdminTicketNewCount,
  AdminTicketPage,
  StoreSettingsView,
  SupportTicketStatus,
  SupportTicketType,
} from '@hg/models';

const BASE = '/api/admin/support';

/** The list's filter; null = all. */
export interface TicketFilter {
  type: SupportTicketType | null;
  status: SupportTicketStatus | null;
  page: number;
}

/**
 * The support inbox (spec §7.2, permission support.manage) and the return window setting (orders.manage). Keeps the
 * "new" counter of the menu badge; it is refreshed on navigation and after a status change (no polling).
 */
@Injectable({ providedIn: 'root' })
export class SupportApi {
  private readonly http = inject(HttpClient);
  /** Tickets in status `new`; null until the first answer (or after a failed one). */
  readonly newCount = signal<number | null>(null);

  list(filter: TicketFilter) {
    let params = new HttpParams().set('page', filter.page);
    if (filter.type) params = params.set('type', filter.type);
    if (filter.status) params = params.set('status', filter.status);
    return firstValueFrom(this.http.get<AdminTicketPage>(BASE, { params }));
  }

  /** Any failure leaves no badge rather than a stale number. */
  async refreshNewCount(): Promise<void> {
    try {
      this.newCount.set((await firstValueFrom(this.http.get<AdminTicketNewCount>(`${BASE}/count-new`))).count);
    } catch {
      this.newCount.set(null);
    }
  }

  detail(number: string | number) {
    return firstValueFrom(this.http.get<AdminTicketDetail>(`${BASE}/${encodeURIComponent(String(number))}`));
  }

  setStatus(number: number, status: SupportTicketStatus) {
    return firstValueFrom(this.http.post<AdminTicketDetail>(`${BASE}/${number}/status`, { status }));
  }

  addNote(number: number, body: string) {
    return firstValueFrom(this.http.post<AdminTicketDetail>(`${BASE}/${number}/notes`, { body }));
  }

  /** The private photo, streamed by the API to a signed-in user with support.manage (same-origin cookie). */
  photoUrl(number: number, attachmentId: number): string {
    return `${BASE}/${number}/attachments/${attachmentId}`;
  }

  storeSettings() {
    return firstValueFrom(this.http.get<StoreSettingsView>('/api/admin/settings/store'));
  }

  saveStoreSettings(input: StoreSettingsView) {
    return firstValueFrom(this.http.put<StoreSettingsView>('/api/admin/settings/store', input));
  }
}
