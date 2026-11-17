import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { AccountBenefit, AccountBenefitStatus } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { formatDate, formatPrice } from '../core/format';
import { AccountNav } from './account-nav';
import { AccountApi, accountErrorMessage, accountFailure } from './account.api';
import { CustomerStore } from './customer.store';

export const BENEFIT_STATUS_LABELS_HE: Record<AccountBenefitStatus, string> = {
  active: 'זמין',
  used: 'נוצל',
  expired: 'פג תוקף',
};

const ORDER: Record<AccountBenefitStatus, number> = { active: 0, used: 1, expired: 2 };

/** "10% הנחה" or "150 ₪ הנחה". */
export function benefitValueText(b: Pick<AccountBenefit, 'discountKind' | 'discountValue'>): string {
  return b.discountKind === 'percent' ? `${b.discountValue}% הנחה` : `${formatPrice(b.discountValue)} הנחה`;
}

/**
 * `/account/benefits` "ההטבות שלי" (CLB-04, spec §4.3): the account's personal codes (the welcome code and codes
 * from staff) with value, minimum purchase, expiry and status, active ones first. Read in the browser only, so the
 * server render holds nothing personal; noindex.
 */
@Component({
  selector: 'hg-account-benefits-page',
  imports: [AccountNav],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './benefits.page.html',
  styleUrl: './account.scss',
})
export class BenefitsPage {
  protected readonly store = inject(CustomerStore);
  private readonly api = inject(AccountApi);

  private readonly loaded = signal<AccountBenefit[] | null>(null);
  /** Active first, then used, then expired; the API's newest-first order is kept inside each group. */
  protected readonly benefits = computed(() => {
    const all = this.loaded();
    return all ? [...all].sort((a, b) => ORDER[a.status] - ORDER[b.status]) : null;
  });
  protected readonly error = signal('');
  protected readonly value = benefitValueText;
  protected readonly price = formatPrice;
  protected readonly date = formatDate;
  protected readonly statusLabel = BENEFIT_STATUS_LABELS_HE;

  constructor() {
    inject(PageMeta).set({
      title: 'ההטבות שלי',
      description: 'קודי ההטבה האישיים בחשבון',
      path: '/account/benefits',
      noindex: true,
    });
    if (isPlatformBrowser(inject(PLATFORM_ID))) {
      void this.store.load();
      void this.read();
    }
  }

  protected async read(): Promise<void> {
    this.error.set('');
    try {
      this.loaded.set(await this.api.benefits());
    } catch (failure) {
      if (this.store.unauthorized(failure)) return;
      this.error.set(accountErrorMessage(accountFailure(failure)));
    }
  }
}
