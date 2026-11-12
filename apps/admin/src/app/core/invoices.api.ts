import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminInvoicesMonth, AdminVatRate, AdminVatRateInput } from '@hg/models';

const BASE = '/api/admin/invoices';

/** The month's documents and the accountant's export (permission invoices.export), and the VAT rates (Super Admin). */
@Injectable({ providedIn: 'root' })
export class InvoicesApi {
  private readonly http = inject(HttpClient);

  month(month: string) {
    return firstValueFrom(this.http.get<AdminInvoicesMonth>(`${BASE}?month=${encodeURIComponent(month)}`));
  }

  documentUrl(id: string): string {
    return `${BASE}/${encodeURIComponent(id)}/document`;
  }

  /** Downloads the month's workbook and hands it to the browser as a file. */
  async downloadExport(month: string) {
    const res = await firstValueFrom(
      this.http.get(`${BASE}/export?month=${encodeURIComponent(month)}`, { responseType: 'blob', observe: 'response' }),
    );
    const name =
      /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `invoices-${month}.xlsx`;
    const url = URL.createObjectURL(res.body!);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  vatRates() {
    return firstValueFrom(this.http.get<AdminVatRate[]>('/api/admin/settings/vat'));
  }

  addVatRate(input: AdminVatRateInput) {
    return firstValueFrom(this.http.post<AdminVatRate>('/api/admin/settings/vat', input));
  }
}
