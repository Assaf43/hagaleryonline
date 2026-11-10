import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';
import type { AddCartItemRequest, CartView, UpdateCartItemRequest } from '@hg/models';

/**
 * The cart API (Phase 4a, CRT-02). The cart lives on the server behind the httpOnly `hg_cart` cookie, which
 * the browser sends with these same-origin calls; every answer is the whole updated cart.
 */
@Injectable({ providedIn: 'root' })
export class CartApi {
  private readonly http = inject(HttpClient);

  get() {
    return firstValueFrom(this.http.get<CartView>('/api/cart'));
  }

  /** Above the line limit the server clamps the quantity and says so in `notices`. */
  add(variantId: number, quantity: number) {
    const body: AddCartItemRequest = { variantId, quantity };
    return firstValueFrom(this.http.post<CartView>('/api/cart/items', body));
  }

  update(variantId: number, quantity: number) {
    const body: UpdateCartItemRequest = { quantity };
    return firstValueFrom(this.http.patch<CartView>(`/api/cart/items/${variantId}`, body));
  }

  remove(variantId: number) {
    return firstValueFrom(this.http.delete<CartView>(`/api/cart/items/${variantId}`));
  }
}
