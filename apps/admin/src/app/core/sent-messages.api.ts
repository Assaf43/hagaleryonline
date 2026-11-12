import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminSentMessage } from '@hg/models';

/**
 * The dev viewer of the messages a mock provider "sent" (spec §5.2, permission orders.manage). The endpoint answers
 * 404 unless both providers are `mock`; `probe()` asks once and `available()` tells the shell whether to show the page.
 */
@Injectable({ providedIn: 'root' })
export class SentMessagesApi {
  private readonly http = inject(HttpClient);
  readonly available = signal(false);

  list() {
    return firstValueFrom(this.http.get<AdminSentMessage[]>('/api/admin/dev/messages'));
  }

  /** Any failure (404 with real providers, 403) means the page is not offered. */
  async probe(): Promise<void> {
    try {
      await this.list();
      this.available.set(true);
    } catch {
      this.available.set(false);
    }
  }
}
