import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { CartView } from '@hg/models';
import { CartApi } from './cart.api';

/**
 * The visitor's cart in the storefront (Phase 4a, CRT-01): the last `CartView` the server sent. Prices and
 * totals always come from the server. The cart belongs to a cookie, so the server render never reads it:
 * there `view` stays `null` and every call is refused; the browser loads it after hydration (the header
 * calls `load()`), so anything that shows it renders only in the browser.
 */
@Injectable({ providedIn: 'root' })
export class CartStore {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly api = inject(CartApi);
  private readonly state = signal<CartView | null>(null);
  /** Bumped by every write, so a slower load that started earlier cannot overwrite a newer cart. */
  private writes = 0;

  readonly view = this.state.asReadonly();
  /** Units in available lines (the header badge). */
  readonly count = computed(() => this.state()?.itemCount ?? 0);
  /** The mini cart dialog (`MiniCart`) follows this. */
  readonly miniCartOpen = signal(false);

  /** Reads the cart; a failure keeps the last view (the header simply shows no count). */
  async load(): Promise<void> {
    if (!this.browser) return;
    const writesBefore = this.writes;
    try {
      const view = await this.api.get();
      if (this.writes === writesBefore) this.state.set(view);
    } catch {
      // Keep what we had.
    }
  }

  add(variantId: number, quantity: number): Promise<CartView> {
    return this.write(() => this.api.add(variantId, quantity));
  }

  setQuantity(variantId: number, quantity: number): Promise<CartView> {
    return this.write(() => this.api.update(variantId, quantity));
  }

  remove(variantId: number): Promise<CartView> {
    return this.write(() => this.api.remove(variantId));
  }

  /** Errors reach the caller, which shows its own message; the last view stays. */
  private async write(call: () => Promise<CartView>): Promise<CartView> {
    if (!this.browser) throw new Error('The cart is not available in the server render');
    this.writes++;
    const view = await call();
    this.state.set(view);
    return view;
  }
}
