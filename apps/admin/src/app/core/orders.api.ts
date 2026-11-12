import { Injectable, inject } from '@angular/core';
import { HttpClient, HttpParams } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  AdminCancelRequest,
  AdminOrderDetail,
  AdminOrderPage,
  AdminRefundRequest,
  AdvanceOrderRequest,
  OrderStatus,
  ProvidersStatus,
} from '@hg/models';

/** Orders, their status actions, cancel and refunds, and the providers status (spec §4, §5.5). Amounts in agorot. */
@Injectable({ providedIn: 'root' })
export class OrdersApi {
  private readonly http = inject(HttpClient);

  list(status: OrderStatus | null, page: number, attention = false) {
    let params = new HttpParams().set('page', page);
    if (status) params = params.set('status', status);
    if (attention) params = params.set('attention', 'true');
    return firstValueFrom(this.http.get<AdminOrderPage>('/api/admin/orders', { params }));
  }

  detail(number: string) {
    return firstValueFrom(this.http.get<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(number)}`));
  }

  /** Every action answers with the fresh order. */
  advance(number: number | string, request: AdvanceOrderRequest) {
    return this.post(number, 'status', request);
  }

  cancel(number: number | string, request: AdminCancelRequest) {
    return this.post(number, 'cancel', request);
  }

  refund(number: number | string, request: AdminRefundRequest) {
    return this.post(number, 'refunds', request);
  }

  retryRefund(number: number | string, refundId: string) {
    return this.post(number, `refunds/${encodeURIComponent(refundId)}/retry`, {});
  }

  private post(number: number | string, path: string, body: object) {
    return firstValueFrom(
      this.http.post<AdminOrderDetail>(`/api/admin/orders/${encodeURIComponent(String(number))}/${path}`, body),
    );
  }

  providers() {
    return firstValueFrom(this.http.get<ProvidersStatus>('/api/admin/providers'));
  }
}
