import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatSnackBar } from '@angular/material/snack-bar';
import type { AdminVatRate } from '@hg/models';
import { errorMessage } from '../core/errors';
import { InvoicesApi } from '../core/invoices.api';

/** 0.18 → "18%" (up to two decimals). */
export function percentLabel(rate: number): string {
  return `${Math.round(rate * 10_000) / 100}%`;
}

/**
 * "מע"מ" (spec §3, Super Admin only): the VAT rates by effective date, and a small form to add a future one. A
 * rate is typed as a percent ("19", "17.5") and sent as a fraction. Rates are never edited or deleted: documents
 * already issued keep the rate they were issued with.
 */
@Component({
  selector: 'hga-vat-page',
  imports: [DatePipe, FormsModule, MatButtonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './vat.page.html',
  styleUrl: './vat.page.scss',
})
export class VatPage {
  private readonly api = inject(InvoicesApi);
  private readonly snack = inject(MatSnackBar);

  protected readonly rates = signal<AdminVatRate[] | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly rate = signal<number | string | null>('');
  protected readonly effectiveFrom = signal('');
  protected readonly percentLabel = percentLabel;

  constructor() {
    void this.load();
  }

  protected reload() {
    void this.load();
  }

  protected async add(event: Event) {
    event.preventDefault();
    const percent = Number(this.rate());
    if (!this.rate() || !Number.isFinite(percent) || !this.effectiveFrom()) {
      this.error.set('יש למלא שיעור ותאריך.');
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.addVatRate({ rate: Math.round(percent * 100) / 10_000, effectiveFrom: this.effectiveFrom() });
      this.rate.set('');
      this.effectiveFrom.set('');
      this.snack.open('השיעור נוסף', 'סגירה', { duration: 4000 });
      await this.load();
    } catch (e) {
      this.error.set(errorMessage(e));
    } finally {
      this.busy.set(false);
    }
  }

  private async load() {
    try {
      this.rates.set(await this.api.vatRates());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
