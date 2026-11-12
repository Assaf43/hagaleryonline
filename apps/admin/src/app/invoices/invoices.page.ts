import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { MatButtonModule } from '@angular/material/button';
import { INVOICE_TYPE_LABELS_HE, type AdminInvoicesMonth } from '@hg/models';
import { formatPrice } from '../catalog/catalog-format';
import { errorMessage } from '../core/errors';
import { InvoicesApi } from '../core/invoices.api';
import { israelDay, israelMonthOf, shiftMonth } from '../promotions/israel-time';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const MONTH_NAME = new Intl.DateTimeFormat('he-IL', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** "2026-11" → "נובמבר 2026". */
export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  return MONTH_NAME.format(new Date(Date.UTC(y, m - 1, 15)));
}

/**
 * "חשבוניות" (spec §5.5, ADM-20, permission invoices.export): the tax documents of one Israel-time month, their
 * totals, and the accountant's Excel export. Opens on the current month; only the answer to the latest request is
 * shown.
 */
@Component({
  selector: 'hga-invoices-page',
  imports: [RouterLink, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './invoices.page.html',
  styleUrl: './invoices.page.scss',
})
export class InvoicesPage {
  private readonly api = inject(InvoicesApi);
  private requestSeq = 0;

  protected readonly month = signal(israelMonthOf(new Date()));
  protected readonly data = signal<AdminInvoicesMonth | null>(null);
  protected readonly loading = signal(false);
  protected readonly exporting = signal(false);
  protected readonly error = signal('');
  protected readonly labels = INVOICE_TYPE_LABELS_HE;
  protected readonly formatPrice = formatPrice;
  protected readonly monthLabel = monthLabel;
  protected readonly israelDay = israelDay;
  protected readonly documentUrl = (id: string) => this.api.documentUrl(id);

  constructor() {
    void this.load();
  }

  protected shift(delta: number) {
    this.setMonth(shiftMonth(this.month(), delta));
  }

  protected pick(event: Event) {
    const value = (event.target as HTMLInputElement).value;
    if (MONTH.test(value)) this.setMonth(value);
  }

  protected reload() {
    void this.load();
  }

  protected async export() {
    this.exporting.set(true);
    this.error.set('');
    try {
      await this.api.downloadExport(this.month());
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.exporting.set(false);
    }
  }

  private setMonth(month: string) {
    if (month === this.month()) return;
    this.month.set(month);
    void this.load();
  }

  private async load() {
    const seq = ++this.requestSeq;
    this.loading.set(true);
    this.error.set('');
    try {
      const result = await this.api.month(this.month());
      if (seq === this.requestSeq) this.data.set(result);
    } catch (e) {
      if (seq === this.requestSeq) this.error.set(errorMessage(e));
    } finally {
      if (seq === this.requestSeq) this.loading.set(false);
    }
  }
}
