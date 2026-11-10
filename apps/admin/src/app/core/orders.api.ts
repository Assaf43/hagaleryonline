import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AdminOrderDetail, AdminOrderPage, OrderStatus, ProvidersStatus } from '@hg/models';

/** Orders (read-only) and the providers status (spec §5.5, ADM-13). Amounts in agorot. */
@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly http = inject(HttpClient);

  list(status: OrderStatus | null, page: number) {
    let params = new HttpParams().set('page', page);
    if (status) params = params.set('status', status);
    return firstValueFrom(this.http.get<AdminOrderPage>('/api/admin/orders', { params }));
  }

  detail(number: string) {
    return firstValueFrom(this.http.get<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(number)}`));
  }

  providers() {
    return firstValueFrom(this.http.get<ProvidersStatus>('/api/admin/providers'));
  }
}
