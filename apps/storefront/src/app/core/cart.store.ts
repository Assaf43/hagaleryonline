import { Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import type { CartNotice, CartView } from '@hg/models';
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
  /** The read in flight and the write count it started at; callers meanwhile share it. */
  private inflight: { done: Promise<void>; writes: number } | null = null;

  readonly view = this.state.asReadonly();
  /** Units in available lines (the header badge). */
  readonly count = computed(() => this.state()?.itemCount ?? 0);
  /** The mini cart dialog (`MiniCart`) follows this. */
  readonly miniCartOpen = signal(false);
  private readonly failed = signal(false);
  /** The last `load()` failed; the cart page and mini cart offer a retry while there is no view yet. */
  readonly loadFailed = this.failed.asReadonly();

  /**
   * Reads the cart; a failure keeps the last view (the header simply shows no count) and sets `loadFailed`.
   * Calls while a read is in flight share it, unless a write happened since it started (its answer would be
   * dropped). The server sends `price_changed` and `quantity_clamped` notices once, so a later read (e.g. the
   * header's background load) keeps those it no longer has, while their line exists, until the next write.
   */
  load(): Promise<void> {
    if (!this.browser) return Promise.resolve();
    if (this.inflight && this.inflight.writes === this.writes) return this.inflight.done;
    const flight = { done: Promise.resolve(), writes: this.writes };
    this.inflight = flight;
    flight.done = this.read(flight);
    return flight.done;
  }

  private async read(flight: { writes: number }): Promise<void> {
    this.failed.set(false);
    // Done in the same step as the state change, so a retry the new state offers starts a new read.
    const settle = () => {
      if (this.inflight === flight) this.inflight = null;
      return this.writes === flight.writes;
    };
    try {
      const view = await this.api.get();
      if (settle()) this.state.set(withCarriedNotices(this.state(), view));
    } catch {
      // Keep what we had.
      if (settle()) this.failed.set(true);
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

  /** Enters a coupon code (spec §6); a refusal (400 with `messageHe`, or 429) reaches the caller. */
  applyCoupon(code: string): Promise<CartView> {
    return this.write(() => this.api.applyCoupon(code));
  }

  removeCoupon(): Promise<CartView> {
    return this.write(() => this.api.removeCoupon());
  }

  /** Errors reach the caller, which shows its own message; the last view stays. */
  private async write(call: () => Promise<CartView>): Promise<CartView> {
    if (!this.browser) throw new Error('The cart is not available in the server render');
    this.writes++;
    const view = await call();
    this.state.set(view);
    this.failed.set(false);
    return view;
  }
}

/**
 * One-time notice kinds the server sends only once: line notices, and the `coupon` notice of a coupon the server
 * removed (unknown, expired or used up — a coupon that only does not apply right now keeps its notice on every read).
 */
const ONE_TIME: ReadonlySet<CartNotice['kind']> = new Set(['price_changed', 'quantity_clamped', 'coupon']);

/**
 * `next` plus the one-time notices of `previous` it lacks that still concern it: a line notice while its line is in
 * the cart; the coupon notice of a dropped coupon (no code before or now) — a code entered since replaces it.
 */
function withCarriedNotices(previous: CartView | null, next: CartView): CartView {
  if (!previous) return next;
  const has = (n: CartNotice) => next.notices.some((m) => m.kind === n.kind && m.variantId === n.variantId);
  const stillRelevant = (n: CartNotice) =>
    n.variantId === null
      ? previous.couponCode === null && next.couponCode === null
      : next.lines.some((l) => l.variantId === n.variantId);
  const carried = previous.notices.filter((n) => ONE_TIME.has(n.kind) && !has(n) && stillRelevant(n));
  return carried.length ? { ...next, notices: [...next.notices, ...carried] } : next;
}
