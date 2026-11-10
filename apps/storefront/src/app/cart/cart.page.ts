import { ChangeDetectionStrategy, Component, afterNextRender, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CartStore } from '../core/cart.store';
import { deliveryEstimateText, formatPrice } from '../core/format';
import { PageMeta } from '../core/page-meta';
import { QuantityStepper } from '../catalog/quantity-stepper';
import { ResponsiveImage } from '../catalog/responsive-image';

/**
 * "סל הקניות" (CRT-01, CRT-02, CRT-04): lines with a quantity stepper and removal, the server's notices,
 * the delivery estimate, the subtotal and the way on to checkout. The cart belongs to a cookie, so the server
 * render shows only the heading; the cart loads after hydration.
 */
@Component({
  selector: 'hg-cart-page',
  imports: [RouterLink, QuantityStepper, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cart.page.html',
  styleUrl: './cart.page.scss',
})
export class CartPage {
  protected readonly cart = inject(CartStore);

  protected readonly loading = computed(() => this.cart.view() === null && !this.cart.loadFailed());
  protected readonly failed = computed(() => this.cart.view() === null && this.cart.loadFailed());
  protected readonly lines = computed(() => this.cart.view()?.lines ?? []);
  protected readonly canCheckout = computed(() => (this.cart.view()?.itemCount ?? 0) > 0);
  protected readonly estimate = computed(() => {
    const e = this.cart.view()?.deliveryEstimate;
    return e ? deliveryEstimateText(e.leadTimeDays) : '';
  });
  protected readonly price = formatPrice;
  /** The line being changed (its controls ignore clicks meanwhile). */
  protected readonly busy = signal<number | null>(null);
  protected readonly error = signal('');

  constructor() {
    inject(PageMeta).set({ title: 'סל הקניות', description: 'המוצרים בסל שלכם', path: '/cart', noindex: true });
    afterNextRender(() => void this.cart.load());
  }

  protected retry(): void {
    void this.cart.load();
  }

  protected setQuantity(variantId: number, quantity: number): Promise<void> {
    return this.change(() => this.cart.setQuantity(variantId, quantity), variantId);
  }

  protected remove(variantId: number): Promise<void> {
    return this.change(() => this.cart.remove(variantId), variantId);
  }

  private async change(call: () => Promise<unknown>, variantId: number): Promise<void> {
    if (this.busy() !== null) return;
    this.busy.set(variantId);
    this.error.set('');
    try {
      await call();
    } catch {
      this.error.set('לא הצלחנו לעדכן את הסל. נסו שוב.');
    } finally {
      this.busy.set(null);
    }
  }
}
