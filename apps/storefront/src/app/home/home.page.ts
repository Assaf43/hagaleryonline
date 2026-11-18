import { ChangeDetectionStrategy, Component, PendingTasks, computed, inject, signal } from '@angular/core';
import type { HomeSectionView } from '@hg/models';
import { ContentApi } from '../content/content.api';
import { PageMeta, SITE_NAME } from '../core/page-meta';
import { SITE_ORIGIN } from '../core/server-tokens';
import { homeJsonLd } from '../core/structured-data';
import { HomeBannerPair } from './home-banner-pair';
import { HomeCategories } from './home-categories';
import { HomeHero } from './home-hero';
import { HomeProducts } from './home-products';
import { HomeRooms } from './home-rooms';
import { HomeTrust } from './home-trust';

/** Home page (GEN-01, NAV-05): the managed sections, resolved by the API in one call. */
@Component({
  selector: 'hg-home-page',
  imports: [HomeHero, HomeTrust, HomeRooms, HomeCategories, HomeProducts, HomeBannerPair],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './home.page.html',
  styleUrl: './home.page.scss',
})
export class HomePage {
  private readonly api = inject(ContentApi);
  private readonly meta = inject(PageMeta);
  private readonly pending = inject(PendingTasks);

  protected readonly sections = signal<HomeSectionView[]>([]);
  /** At most one hero: the first one; later hero sections are ignored. */
  protected readonly visibleSections = computed(() => {
    let heroSeen = false;
    return this.sections().filter((s) => {
      if (s.kind !== 'hero') return true;
      const keep = !heroSeen;
      heroSeen = true;
      return keep;
    });
  });
  protected readonly failed = signal(false);

  constructor() {
    this.meta.set({
      title: SITE_NAME,
      description: 'ספות, כורסאות ואביזרים לסלון, עם מידות מלאות לכל דגם, סינון לפי רוחב ועומק ומשלוח עד הבית.',
      path: '/',
      jsonLd: homeJsonLd(inject(SITE_ORIGIN)),
    });
    this.reload();
  }

  protected reload(): void {
    void this.pending.run(() => this.load());
  }

  private async load() {
    this.failed.set(false);
    try {
      this.sections.set((await this.api.home()).sections);
    } catch {
      this.failed.set(true);
      this.meta.serverError();
    }
  }
}
