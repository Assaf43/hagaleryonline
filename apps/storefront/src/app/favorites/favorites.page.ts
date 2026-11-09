import {
  ChangeDetectionStrategy,
  Component,
  PendingTasks,
  afterNextRender,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import type { ProductCard as Card } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { FavoritesStore } from '../core/favorites.store';
import { PageMeta } from '../core/page-meta';
import { ProductCard } from '../catalog/product-card';

/**
 * "המועדפים שלי" (CMP-01, NAV-03): the products saved on this device, newest first. The list lives in the
 * browser only, so the server renders just the heading and the cards load after hydration. Products the API
 * no longer returns (hidden or removed) are dropped from the saved list. A heart pressed here keeps its card
 * on the page until the next visit, so a mistaken click can be undone.
 */
@Component({
  selector: 'hg-favorites-page',
  imports: [RouterLink, ProductCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './favorites.page.html',
  styleUrl: './favorites.page.scss',
})
export class FavoritesPage {
  private readonly api = inject(CatalogApi);
  private readonly favorites = inject(FavoritesStore);
  private readonly tasks = inject(PendingTasks);

  /** null until loaded in the browser (also the whole server render). */
  protected readonly cards = signal<Card[] | null>(null);
  protected readonly loadFailed = signal(false);

  constructor() {
    inject(PageMeta).set({ title: 'המועדפים שלי', description: 'המוצרים ששמרתם', path: '/favorites', noindex: true });
    afterNextRender(() => this.load());
  }

  protected load(): void {
    this.loadFailed.set(false);
    void this.tasks.run(async () => {
      const ids = untracked(this.favorites.ids);
      if (!ids.length) return this.cards.set([]);
      try {
        const found = new Map((await firstValueFrom(this.api.cards(ids))).map((c) => [c.id, c]));
        const missing = ids.filter((id) => !found.has(id));
        if (missing.length) this.favorites.remove(missing);
        this.cards.set(ids.flatMap((id) => found.get(id) ?? []));
      } catch {
        this.loadFailed.set(true);
      }
    });
  }
}
