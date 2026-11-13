import { Injectable, PLATFORM_ID, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import type { CustomerMe } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { AccountApi, accountFailure } from './account.api';

/**
 * The signed-in customer (Phase 5c, ACC-01): the last `CustomerMe` the server sent, or `null`. The session is an
 * httpOnly cookie, so the server render never reads it: there `me` stays `null` and `ready` false; the browser
 * loads it after hydration (the header and the account pages call `load()`). Anything that shows the customer
 * renders only in the browser. A sign-in or sign-out reloads the cart, because the server resolves another cart.
 */
@Injectable({ providedIn: 'root' })
export class CustomerStore {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly api = inject(AccountApi);
  private readonly cart = inject(CartStore);
  private readonly router = inject(Router);
  private readonly state = signal<CustomerMe | null>(null);
  private readonly loaded = signal(false);
  private inflight: Promise<void> | null = null;

  readonly me = this.state.asReadonly();
  /** The session was read (the answer may be "nobody"). */
  readonly ready = this.loaded.asReadonly();

  /** Reads the session once; callers meanwhile share the read. A failed read counts as signed out. */
  load(): Promise<void> {
    if (!this.browser || this.loaded()) return Promise.resolve();
    this.inflight ??= this.read();
    return this.inflight;
  }

  private async read(): Promise<void> {
    try {
      this.state.set((await this.api.me()) ?? null);
    } catch {
      this.state.set(null);
    }
    this.loaded.set(true);
    this.inflight = null;
  }

  /** Sets what the server just sent (a changed phone, a first password) without touching the cart. */
  restore(me: CustomerMe | null): void {
    this.state.set(me);
    this.loaded.set(true);
  }

  /** After a sign-in (or sign-up, or password reset): the customer, and the cart the account now owns. */
  setCustomer(me: CustomerMe): void {
    this.restore(me);
    void this.cart.refresh();
  }

  /**
   * Signs out. A failed call rejects and keeps the customer signed in (the page shows an error), because the
   * cookie may still be valid.
   */
  async signOut(): Promise<void> {
    await this.api.signOut();
    this.restore(null);
    void this.cart.refresh();
  }

  /**
   * For a signed-in page's `catch`: a 401 `not_authenticated` means the session ended (expired, or ended from another
   * device), so the customer state is cleared and the visitor goes to `/account?next=<this page>`. Returns whether it
   * did (other errors, including a wrong code's 401, stay with the page).
   */
  unauthorized(error: unknown): boolean {
    const failure = accountFailure(error);
    if (failure.status !== 401 || failure.code !== 'not_authenticated') return false;
    this.restore(null);
    void this.cart.refresh();
    void this.router.navigate(['/account'], { queryParams: { next: this.router.url } });
    return true;
  }
}
