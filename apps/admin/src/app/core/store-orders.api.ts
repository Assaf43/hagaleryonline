import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type {
  CustomerAddressView,
  LocalityOption,
  ProductDetail,
  SearchSuggestions,
  ShippingQuote,
  ShippingQuoteRequest,
  StoreCartView,
  StoreCodeRequest,
  StoreCustomerLookup,
  StoreOrderCreated,
  StoreOrderRequest,
  StoreOrderRetry,
  StoreOrderStatus,
  StorePendingOrder,
  StoreVerifyRequest,
} from '@hg/models';

const CART = '/api/admin/store-cart';
const ORDERS = '/api/admin/store-orders';

/** The seller's store cart, customer confirmation and store orders (Phase 6, ADM-18). Amounts in agorot. */
@Injectable({ providedIn: 'root' })
export class StoreOrdersApi {
  private readonly http = inject(HttpClient);

  /** The open cart, or null (204) when there is none. */
  cart() {
    return firstValueFrom(this.http.get<StoreCartView | null>(CART)).then((v) => v ?? null);
  }

  startSale() {
    return firstValueFrom(this.http.post<StoreCartView>(CART, {}));
  }

  addItem(variantId: number, quantity: number) {
    return firstValueFrom(this.http.post<StoreCartView>(`${CART}/items`, { variantId, quantity }));
  }

  setQuantity(variantId: number, quantity: number) {
    return firstValueFrom(this.http.patch<StoreCartView>(`${CART}/items/${variantId}`, { quantity }));
  }

  removeItem(variantId: number) {
    return firstValueFrom(this.http.delete<StoreCartView>(`${CART}/items/${variantId}`));
  }

  applyCoupon(code: string) {
    return firstValueFrom(this.http.post<StoreCartView>(`${CART}/coupon`, { code }));
  }

  removeCoupon() {
    return firstValueFrom(this.http.delete<StoreCartView>(`${CART}/coupon`));
  }

  lookup(phone: string) {
    return firstValueFrom(this.http.post<StoreCustomerLookup>(`${CART}/customer/lookup`, { phone }));
  }

  sendCode(request: StoreCodeRequest) {
    return firstValueFrom(this.http.post<void>(`${CART}/customer/code`, request));
  }

  verify(request: StoreVerifyRequest) {
    return firstValueFrom(this.http.post<StoreCartView>(`${CART}/customer/verify`, request));
  }

  clearCustomer() {
    return firstValueFrom(this.http.delete<StoreCartView>(`${CART}/customer`));
  }

  addresses() {
    return firstValueFrom(this.http.get<CustomerAddressView[]>(`${CART}/customer/addresses`));
  }

  quote(request: ShippingQuoteRequest) {
    return firstValueFrom(this.http.post<ShippingQuote>(`${CART}/shipping-quote`, request));
  }

  /** The public locality search the storefront checkout uses. */
  localities(q: string) {
    return firstValueFrom(this.http.get<LocalityOption[]>('/api/localities', { params: { q } }));
  }

  /** The public search suggestions and product page the storefront uses. */
  suggest(q: string) {
    return firstValueFrom(this.http.get<SearchSuggestions>('/api/search/suggest', { params: { q } }));
  }

  product(slug: string) {
    return firstValueFrom(this.http.get<ProductDetail>(`/api/products/${encodeURIComponent(slug)}`));
  }

  createOrder(request: StoreOrderRequest) {
    return firstValueFrom(this.http.post<StoreOrderCreated>(ORDERS, request));
  }

  pending() {
    return firstValueFrom(this.http.get<StorePendingOrder[]>(`${ORDERS}/pending`));
  }

  status(number: number) {
    return firstValueFrom(this.http.get<StoreOrderStatus>(`${ORDERS}/${number}`));
  }

  retry(number: number) {
    return firstValueFrom(this.http.post<StoreOrderRetry>(`${ORDERS}/${number}/retry`, {}));
  }

  cancel(number: number) {
    return firstValueFrom(this.http.post<StoreOrderStatus>(`${ORDERS}/${number}/cancel`, {}));
  }
}
