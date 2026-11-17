import { DestroyRef, Injectable, PLATFORM_ID, computed, effect, inject, signal, untracked } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { FAVORITES_MAX } from '@hg/models';
import { AccountApi } from '../account/account.api';
import { CustomerStore } from '../account/customer.store';

export const FAVORITES_KEY = 'hg.favorites';
/** The account id the device list was last merged into; set after a merge, cleared on sign-out. */
export const FAVORITES_MERGED_KEY = 'hg.favorites.merged';
export { FAVORITES_MAX };

/** Stored JSON → valid ids: positive integers, each once, at most `FAVORITES_MAX`. Anything else is dropped. */
function parse(raw: string | null): number[] {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(value)) return [];
  const ids = value.filter((v): v is number => Number.isInteger(v) && v > 0);
  return [...new Set(ids)].slice(0, FAVORITES_MAX);
}

/**
 * Favorite products (CMP-01, CLB-09): product ids, newest first. Signed out, the list lives on this device in
 * `localStorage` (`hg.favorites`); every storage access may throw (private mode, blocked site data), so the list then
 * lives in memory only, and other tabs are followed through the `storage` event. When the customer signs in, the
 * device list is merged into the account's (the server keeps the union) and from then on the account's list is shown
 * and every change is written through to the server. Signing out drops the account copy and shows the device list
 * again, untouched: another account signing in later never sees this one's favorites. On the server the list is
 * always empty and nothing is read, so anything that depends on it must render only in the browser (after hydration).
 */
@Injectable({ providedIn: 'root' })
export class FavoritesStore {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly customer = inject(CustomerStore);
  private readonly api = inject(AccountApi);
  private readonly device = signal<readonly number[]>([]);
  /** The signed-in account's list, once the merge answered; null while signed out or before that. */
  private readonly account = signal<{ customerId: string; ids: readonly number[] } | null>(null);
  private following: string | null = null;

  readonly ids = computed(() => this.account()?.ids ?? this.device());
  readonly count = computed(() => this.ids().length);
  /** Where `ids` come from: `'device'` or the account id. A change means the list was swapped as a whole. */
  readonly source = computed(() => this.account()?.customerId ?? 'device');

  constructor() {
    if (!this.browser) return;
    this.device.set(this.read());
    const follow = (e: StorageEvent) => {
      // `key` is null when the other tab cleared the whole storage.
      if (e.key === FAVORITES_KEY || e.key === null) this.device.set(parse(e.newValue));
    };
    window.addEventListener('storage', follow);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', follow));
    effect(() => {
      const id = this.customer.me()?.id ?? null;
      untracked(() => this.follow(id));
    });
  }

  has(id: number): boolean {
    return this.ids().includes(id);
  }

  toggle(id: number): void {
    const ids = this.ids();
    if (ids.includes(id)) this.remove([id]);
    else this.add(id);
  }

  remove(ids: readonly number[]): void {
    const drop = new Set(ids);
    const account = this.account();
    const next = this.ids().filter((i) => !drop.has(i));
    if (next.length === this.ids().length) return;
    if (!account) return this.save(next);
    // A removal also leaves the device list, so it is never merged back into the account.
    this.save(this.device().filter((i) => !drop.has(i)));
    this.account.set({ customerId: account.customerId, ids: next });
    const removed = account.ids.filter((i) => drop.has(i));
    this.writeThrough(account.customerId, () => Promise.all(removed.map((i) => this.api.removeFavorite(i))));
  }

  private add(id: number): void {
    const account = this.account();
    if (!account) return this.save([id, ...this.device()].slice(0, FAVORITES_MAX));
    this.account.set({ customerId: account.customerId, ids: [id, ...account.ids].slice(0, FAVORITES_MAX) });
    this.writeThrough(account.customerId, async () =>
      this.take(account.customerId, await this.api.mergeFavorites([id])),
    );
  }

  /** The customer changed (or signed out): drop the old account copy and, for an account, merge the device list in. */
  private follow(customerId: string | null): void {
    if (customerId === this.following) return;
    const wasSignedIn = this.following !== null;
    this.following = customerId;
    if (!customerId && wasSignedIn) this.setMarker(null);
    this.account.set(null);
    if (customerId) void this.merge(customerId);
  }

  private async merge(customerId: string): Promise<void> {
    try {
      // The device list goes in once per device and account; after that (a reload) only the account list is read.
      if (this.marker() === customerId) {
        this.take(customerId, await this.api.favorites());
        return;
      }
      this.take(customerId, await this.api.mergeFavorites(untracked(this.device)));
      if (this.following === customerId) this.setMarker(customerId);
    } catch {
      // The merge failed: the device list stays shown and kept; the next sign-in merges again.
    }
  }

  /** Shows the server's list, unless the customer changed meanwhile. */
  private take(customerId: string, ids: readonly number[]): void {
    if (this.following === customerId) this.account.set({ customerId, ids });
  }

  /** A write to the server; on a failure the list is read again so the screen shows what the server has. */
  private writeThrough(customerId: string, call: () => Promise<unknown>): void {
    call().catch(async () => {
      try {
        this.take(customerId, await this.api.favorites());
      } catch {
        // Offline or signed out: the screen keeps the optimistic list until the next load.
      }
    });
  }

  private marker(): string | null {
    try {
      return localStorage.getItem(FAVORITES_MERGED_KEY);
    } catch {
      return null;
    }
  }

  private setMarker(customerId: string | null): void {
    try {
      if (customerId) localStorage.setItem(FAVORITES_MERGED_KEY, customerId);
      else localStorage.removeItem(FAVORITES_MERGED_KEY);
    } catch {
      // Storage is blocked: the device list is merged again at the next start, which only adds what is missing.
    }
  }

  private read(): number[] {
    try {
      return parse(localStorage.getItem(FAVORITES_KEY));
    } catch {
      return [];
    }
  }

  private save(ids: readonly number[]): void {
    if (!this.browser) return;
    this.device.set(ids);
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
    } catch {
      // Storage is full or blocked: keep the list in memory for this visit.
    }
  }
}
