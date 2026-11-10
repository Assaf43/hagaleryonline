import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminShippingConfig,
  AdminShippingRatesInput,
  AdminShippingZone,
  AdminShippingZoneInput,
  LocalityOption,
} from '@hg/models';

const BASE = '/api/admin/shipping';

/** Shipping price list and remote zones (spec §4.4, ADM-07). Amounts in agorot. */
@Injectable({ providedIn: 'root' })
export class ShippingApi {
  private readonly http = inject(HttpClient);

  config() {
    return firstValueFrom(this.http.get<AdminShippingConfig>(BASE));
  }

  saveRates(input: AdminShippingRatesInput) {
    return firstValueFrom(this.http.put<AdminShippingConfig>(`${BASE}/rates`, input));
  }

  createZone(input: AdminShippingZoneInput) {
    return firstValueFrom(this.http.post<AdminShippingZone>(`${BASE}/zones`, input));
  }

  updateZone(id: number, input: AdminShippingZoneInput) {
    return firstValueFrom(this.http.put<AdminShippingZone>(`${BASE}/zones/${id}`, input));
  }

  deleteZone(id: number) {
    return firstValueFrom(this.http.delete<void>(`${BASE}/zones/${id}`));
  }

  /** The public localities search (up to 10 matches). */
  localities(q: string) {
    return firstValueFrom(this.http.get<LocalityOption[]>('/api/localities', { params: { q } }));
  }
}
