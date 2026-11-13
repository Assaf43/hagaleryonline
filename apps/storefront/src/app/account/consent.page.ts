import { ChangeDetectionStrategy, Component, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { AccountConsent } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { formatDate } from '../core/format';
import { AccountNav } from './account-nav';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import { CustomerStore } from './customer.store';

/**
 * `/account/consent` (ACC-05, CLAUDE.md §4.4): the marketing consent. One checkbox that saves at once, so giving it
 * and withdrawing it are each one click; the result is announced in a status line. The server records the time and
 * the source (`account`).
 */
@Component({
  selector: 'hg-account-consent-page',
  imports: [AccountNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './consent.page.html',
  styleUrl: './account.scss',
})
export class ConsentPage {
  protected readonly store = inject(CustomerStore);
  private readonly api = inject(AccountApi);

  protected readonly busy = signal(false);
  protected readonly status = signal('');
  protected readonly error = signal('');
  /** The last answer of the server (with the consent's time). */
  protected readonly result = signal<AccountConsent | null>(null);
  protected readonly date = formatDate;

  constructor() {
    inject(PageMeta).set({
      title: 'הסכמה לדיוור',
      description: 'ניהול ההסכמה לקבלת דיוור ועדכונים',
      path: '/account/consent',
      noindex: true,
    });
    if (isPlatformBrowser(inject(PLATFORM_ID))) void this.store.load();
  }

  /** What the checkbox says now; a change made while a save runs is saved right after it. */
  private wanted = false;

  protected async toggle(event: Event): Promise<void> {
    const box = event.target as HTMLInputElement;
    this.wanted = box.checked;
    if (this.busy()) return;
    this.busy.set(true);
    this.status.set('');
    this.error.set('');
    try {
      while (this.wanted !== (this.store.me()?.marketingConsent ?? false)) {
        const saved = await this.api.setConsent(this.wanted);
        this.result.set(saved);
        const me = this.store.me();
        if (me) {
          this.store.restore({
            ...me,
            marketingConsent: saved.marketingConsent,
            marketingConsentAt: saved.marketingConsentAt,
          });
        }
        this.status.set(saved.marketingConsent ? 'ההסכמה לדיוור נשמרה' : 'ההסכמה לדיוור בוטלה');
      }
    } catch (failure) {
      if (this.store.unauthorized(failure)) return;
      // The checkbox goes back to what the account has.
      box.checked = this.store.me()?.marketingConsent ?? false;
      this.error.set(accountErrorMessage(accountFailure(failure)));
    } finally {
      this.busy.set(false);
    }
  }
}
