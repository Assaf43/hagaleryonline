import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { LucideTicketPercent } from '@lucide/angular';
import { MAX_COUPON_CODE_LENGTH } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { checkoutErrorMessage } from '../checkout/checkout.api';

let nextId = 0;

/**
 * The cart's coupon (spec §6, CRT-03): a "קוד קופון" field with "החלה"; once entered, the code as a chip with
 * "הסרה" — also when it does not apply right now (below its minimum, or an automatic promotion is better), with
 * the server's reason. A refused code shows the reason under the field (400 `messageHe`, 429 the throttle text);
 * the outcome is announced in a polite live region.
 */
@Component({
  selector: 'hg-coupon-field',
  imports: [LucideTicketPercent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './coupon-field.html',
  styleUrl: './coupon-field.scss',
})
export class CouponField {
  protected readonly cart = inject(CartStore);
  private readonly injector = inject(Injector);
  private readonly input = viewChild<ElementRef<HTMLInputElement>>('codeInput');

  protected readonly inputId = `hg-coupon-${nextId++}`;
  protected readonly errorId = `${this.inputId}-error`;
  protected readonly maxLength = MAX_COUPON_CODE_LENGTH;
  protected readonly code = signal('');
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  /** Read out by the live region: "הקופון הוחל" / "הקופון הוסר". */
  protected readonly status = signal('');

  /** The code on the cart, applied or not. */
  protected readonly entered = computed(() => this.cart.view()?.couponCode ?? null);
  protected readonly notices = computed(() => (this.cart.view()?.notices ?? []).filter((n) => n.kind === 'coupon'));

  protected setCode(event: Event) {
    this.code.set((event.target as HTMLInputElement).value);
    this.error.set('');
  }

  protected async apply(event: Event) {
    event.preventDefault();
    const code = this.code().trim();
    if (!code || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    this.status.set('');
    try {
      const view = await this.cart.applyCoupon(code);
      this.code.set('');
      // Applied, or kept with its reason (the notice) when an automatic promotion is better.
      this.status.set(view.discount?.source === 'coupon' ? 'הקופון הוחל' : '');
    } catch (e) {
      this.error.set(refusal(e));
      afterNextRender(() => this.input()?.nativeElement.focus(), { injector: this.injector });
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove() {
    if (this.busy()) return;
    this.busy.set(true);
    this.status.set('');
    try {
      await this.cart.removeCoupon();
      this.status.set('הקופון הוסר');
    } catch {
      this.status.set('לא הצלחנו להסיר את הקופון. נסו שוב.');
    } finally {
      this.busy.set(false);
    }
  }
}

/** The reason a code was refused, in Hebrew. */
function refusal(e: unknown): string {
  if (e instanceof HttpErrorResponse) {
    const body = (e.error ?? {}) as { code?: unknown; messageHe?: unknown };
    if (body.code === 'invalid_coupon' && typeof body.messageHe === 'string') return body.messageHe;
    if (e.status === 429) return checkoutErrorMessage('too_many_requests');
  }
  return 'לא הצלחנו לבדוק את הקופון. נסו שוב.';
}
