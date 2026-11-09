import { DestroyRef, Injectable, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

export const FAVORITES_KEY = 'hg.favorites';
export const FAVORITES_MAX = 100;

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
 * Favorite products on this device (CMP-01): product ids, newest first, in `localStorage` (`hg.favorites`).
 * Every storage access may throw (private mode, blocked site data), so the list then lives in memory only.
 * Other tabs are followed through the `storage` event. On the server the list is always empty and storage is
 * never touched, so anything that depends on it must render only in the browser (after hydration).
 * Phase 5 (CMP-02) syncs it to the customer account behind this same interface.
 */
@Injectable({ providedIn: 'root' })
export class FavoritesStore {
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly list = signal<readonly number[]>([]);

  readonly ids = this.list.asReadonly();
  readonly count = computed(() => this.list().length);

  constructor() {
    if (!this.browser) return;
    this.list.set(this.read());
    const follow = (e: StorageEvent) => {
      // `key` is null when the other tab cleared the whole storage.
      if (e.key === FAVORITES_KEY || e.key === null) this.list.set(parse(e.newValue));
    };
    window.addEventListener('storage', follow);
    inject(DestroyRef).onDestroy(() => window.removeEventListener('storage', follow));
  }

  has(id: number): boolean {
    return this.list().includes(id);
  }

  toggle(id: number): void {
    const ids = this.list();
    this.save(ids.includes(id) ? ids.filter((i) => i !== id) : [id, ...ids].slice(0, FAVORITES_MAX));
  }

  remove(ids: readonly number[]): void {
    const drop = new Set(ids);
    const next = this.list().filter((i) => !drop.has(i));
    if (next.length !== this.list().length) this.save(next);
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
    this.list.set(ids);
    try {
      localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
    } catch {
      // Storage is full or blocked: keep the list in memory for this visit.
    }
  }
}
