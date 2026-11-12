import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import { MatButtonModule } from '@angular/material/button';
import type { AdminSentMessage } from '@hg/models';
import { errorMessage } from '../core/errors';
import { SentMessagesApi } from '../core/sent-messages.api';

/**
 * "הודעות שנשלחו (בדיקה)" (spec §5.2, permission orders.manage): the last 100 messages the mock provider logged,
 * OTP codes included. It exists only while both providers are mocks. An e-mail body is shown in a sandboxed iframe
 * (`sandbox=""`: no scripts, no same-origin access), an SMS as plain text.
 */
@Component({
  selector: 'hga-sent-messages-page',
  imports: [DatePipe, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './sent-messages.page.html',
  styleUrl: './sent-messages.page.scss',
})
export class SentMessagesPage {
  private readonly api = inject(SentMessagesApi);
  private readonly sanitizer = inject(DomSanitizer);

  protected readonly items = signal<AdminSentMessage[] | null>(null);
  protected readonly error = signal('');
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => {
    const list = this.items();
    return list?.find((m) => m.id === this.selectedId()) ?? list?.[0] ?? null;
  });
  /**
   * The e-mail HTML is our own rendering of a template, and the iframe is sandboxed without any permission, so
   * trusting it here cannot run script or reach the admin app.
   */
  protected readonly emailDoc = computed<SafeHtml | null>(() => {
    const m = this.selected();
    return m?.channel === 'email' && m.body ? this.sanitizer.bypassSecurityTrustHtml(m.body) : null;
  });

  constructor() {
    void this.load();
  }

  protected select(id: string) {
    this.selectedId.set(id);
  }

  protected reload() {
    void this.load();
  }

  private async load() {
    this.error.set('');
    try {
      this.items.set(await this.api.list());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
