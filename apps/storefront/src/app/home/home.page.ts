import { ChangeDetectionStrategy, Component, PendingTasks, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideRuler, LucideSlidersHorizontal, LucideTruck } from '@lucide/angular';
import type { ImageRef, ProductCard as Card } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { PageMeta, SITE_NAME } from '../core/page-meta';
import { MenuData } from '../layout/menu-data';
import { ProductCard } from '../catalog/product-card';
import { ResponsiveImage } from '../catalog/responsive-image';

/**
 * Home page (GEN-01): rooms with their furniture types, best sellers and new arrivals. Banners and
 * editable content come with the CMS in Phase 8.
 */
@Component({
  selector: 'hg-home-page',
  imports: [RouterLink, ProductCard, ResponsiveImage, LucideRuler, LucideSlidersHorizontal, LucideTruck],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
})
export class HomePage {
  private readonly api = inject(CatalogApi);
  protected readonly menu = inject(MenuData);

  protected readonly bestsellers = signal<Card[]>([]);
  protected readonly newest = signal<Card[]>([]);
  /** A photo per furniture type, from its first product. */
  protected readonly typeImages = signal<Record<string, ImageRef | null>>({});
  protected readonly heroImage = computed(() => this.bestsellers()[0]?.image ?? null);
  protected readonly firstRoom = computed(() => this.menu.rooms()[0] ?? null);

  constructor() {
    inject(PageMeta).set({
      title: SITE_NAME,
      description: 'ספות, כורסאות ואביזרים לסלון, עם מידות מלאות לכל דגם, סינון לפי רוחב ועומק ומשלוח עד הבית.',
      path: '/',
    });
    void inject(PendingTasks).run(() => this.load());
  }

  private async load() {
    try {
      const [best, fresh] = await Promise.all([
        this.api.products({ sort: 'bestsellers', pageSize: '4' }),
        this.api.products({ sort: 'newest', pageSize: '4' }),
        this.menu.load(),
      ]);
      this.bestsellers.set(best.items);
      this.newest.set(fresh.items);
      const slugs = [...new Set(this.menu.rooms().flatMap((r) => r.categories.map((c) => c.slug)))];
      const firsts = await Promise.all(
        slugs.map((category) =>
          this.api.products({ category, pageSize: '1' }).then(
            (r) => [category, r.items[0]?.image ?? null] as const,
            () => [category, null] as const,
          ),
        ),
      );
      this.typeImages.set(Object.fromEntries(firsts));
    } catch {
      // The menus and links still work; product rows stay empty.
    }
  }
}
