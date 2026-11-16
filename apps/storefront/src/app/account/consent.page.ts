import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CONSENT_TEXT_HE, type AccountConsent } from '@hg/models';
import { isPlatformBrowser } from '@angular/common';
import { PageMeta } from '../core/page-meta';
import { formatDate } from '../core/format';
import { AccountNav } from './account-nav';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import { CustomerStore } from './customer.store';

/**
 * `/account/consent` (ACC-05, CLAUDE.md §4.4): the marketing consent, read from the account e-mail's marketing contact
 * (`GET /api/account/consent`). One checkbox that saves at once, so giving it and withdrawing it are each one click;
 * the result is announced in a status line. The state decides first: a subscribed contact always shows the checkbox
 * (untick to withdraw) and a request waiting for the customer's link (sent by e-mail, or by SMS from the store) shows as
 * pending with a cancel button, even when the account's e-mail is unverified (a store quick account, decision 96);
 * only giving consent needs a verified e-mail, so the verify prompt replaces the checkbox otherwise (decision 95).
 */
@Component({
  selector: 'hg-account-consent-page',
  imports: [AccountNav, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './consent.page.html',
  styleUrl: './account.scss',
})
export class ConsentPage {
  protected readonly store = inject(CustomerStore);
  private readonly api = inject(AccountApi);

  /** The contact of the account's e-mail; null until the browser has read it. */
  protected readonly consent = signal<AccountConsent | null>(null);
  protected readonly subscribed = computed(() => this.consent()?.status === 'subscribed');
  protected readonly pending = computed(() => this.consent()?.status === 'pending');
  protected readonly text = CONSENT_TEXT_HE;
  protected readonly busy = signal(false);
  protected readonly status = signal('');
  protected readonly error = signal('');
  protected readonly date = formatDate;

  constructor() {
    inject(PageMeta).set({
      title: 'הסכמה לדיוור',
      description: 'ניהול ההסכמה לקבלת דיוור ועדכונים',
      path: '/account/consent',
      noindex: true,
    });
    if (isPlatformBrowser(inject(PLATFORM_ID))) {
      void this.store.load();
      void this.read();
    }
  }

  private async read(): Promise<void> {
    try {
      this.consent.set(await this.api.consent());
    } catch (failure) {
      if (this.store.unauthorized(failure)) return;
      this.error.set(accountErrorMessage(accountFailure(failure)));
    }
  }

  /** What the customer wants now; a change made while a save runs is saved right after it. */
  private wanted = false;

  protected toggle(event: Event): Promise<void> {
    const box = event.target as HTMLInputElement;
    this.wanted = box.checked;
    return this.save(box);
  }

  /** "ביטול הבקשה": withdraws a request that still waits for the e-mail link. */
  protected cancelPending(): Promise<void> {
    this.wanted = false;
    return this.save(null);
  }

  private async save(box: HTMLInputElement | null): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.status.set('');
    this.error.set('');
    try {
      let saved: AccountConsent;
      do {
        saved = await this.api.setConsent(this.wanted);
        this.consent.set(saved);
        const me = this.store.me();
        if (me) {
          this.store.restore({
            ...me,
            marketingConsent: saved.status === 'subscribed',
            marketingConsentAt: saved.consentAt,
          });
        }
        this.status.set(saved.status === 'subscribed' ? 'ההסכמה לדיוור נשמרה' : 'ההסכמה לדיוור בוטלה');
        // A change made while this save ran is saved next.
      } while (this.wanted !== (saved.status === 'subscribed'));
    } catch (failure) {
      if (this.store.unauthorized(failure)) return;
      const f = accountFailure(failure);
      if (f.code === 'email_not_verified') {
        // The verify prompt replaces the checkbox.
        this.consent.update((c) => (c ? { ...c, emailVerified: false } : c));
      } else {
        // The checkbox goes back to what the contact has.
        if (box) box.checked = this.subscribed();
        this.error.set(accountErrorMessage(f));
      }
    } finally {
      this.busy.set(false);
    }
  }
}
