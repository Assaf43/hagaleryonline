import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminPromotion, AdminPromotionInput, PromotionCategoryOption } from '@hg/models';

const BASE = '/api/admin/promotions';

/** "מבצעים וקופונים" (spec §6, ADM-05). Amounts in agorot, times in UTC ISO. */
@Injectable({ providedIn: 'root' })
export class PromotionsApi {
  private readonly http = inject(HttpClient);

  list() {
    return firstValueFrom(this.http.get<AdminPromotion[]>(BASE));
  }

  get(id: number) {
    return firstValueFrom(this.http.get<AdminPromotion>(`${BASE}/${id}`));
  }

  categories() {
    return firstValueFrom(this.http.get<PromotionCategoryOption[]>(`${BASE}/categories`));
  }

  create(input: AdminPromotionInput) {
    return firstValueFrom(this.http.post<AdminPromotion>(BASE, input));
  }

  update(id: number, input: AdminPromotionInput) {
    return firstValueFrom(this.http.put<AdminPromotion>(`${BASE}/${id}`, input));
  }

  deactivate(id: number) {
    return firstValueFrom(this.http.post<AdminPromotion>(`${BASE}/${id}/deactivate`, null));
  }
}
