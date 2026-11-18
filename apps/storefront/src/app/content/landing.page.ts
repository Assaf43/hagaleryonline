import {
  ChangeDetectionStrategy,
  Component,
  PendingTasks,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router, RouterLink } from '@angular/router';
import type { LandingEnded, LandingPageView, ProductCard as Card } from '@hg/models';
import { ProductCard } from '../catalog/product-card';
import { productCount } from '../core/format';
import { PageMeta } from '../core/page-meta';
import { BannerImage } from '../home/banner-image';
import { linkTarget } from '../home/link-target';
import { ContentApi } from './content.api';
import { RichText } from './rich-text';

/** Sorts of a landing page grid; "recommended" is the source's order. */
export type LandingSort = 'recommended' | 'price_asc' | 'price_desc' | 'newest';

export const LANDING_SORT_LABELS: Record<LandingSort, string> = {
  recommended: 'מומלץ',
  price_asc: 'מחיר: מהנמוך לגבוה',
  price_desc: 'מחיר: מהגבוה לנמוך',
  newest: 'חדש באתר',
};

export const parseLandingSort = (value: string | null | undefined): LandingSort =>
  value && value in LANDING_SORT_LABELS ? (value as LandingSort) : 'recommended';

/** Sorts the returned cards on the client (a stable sort; ids missing from `newestOrder` go last). */
export function sortLandingItems(items: Card[], newestOrder: number[], sort: LandingSort): Card[] {
  const list = [...items];
  if (sort === 'price_asc') return list.sort((a, b) => a.priceFrom - b.priceFrom);
  if (sort === 'price_desc') return list.sort((a, b) => b.priceFrom - a.priceFrom);
  if (sort === 'newest') {
    const rank = (c: Card) => {
      const i = newestOrder.indexOf(c.id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    return list.sort((a, b) => rank(a) - rank(b));
  }
  return list;
}

/**
 * `/collection/:slug` (MKT-02, decision 97): a campaign page with an opening photo, intro, sortable product grid and a
 * closing text. Ended → 410 with a button on; unknown or hidden → 404; `?preview=` shows a draft to staff (noindex).
 */
@Component({
  selector: 'hg-landing-page',
  imports: [RouterLink, RichText, BannerImage, ProductCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (preview() && page()) {
      <div class="preview-strip" role="status">תצוגה מקדימה</div>
    }
    @if (notFound()) {
      <section class="container empty">
        <h1>הדף לא נמצא</h1>
        <p class="muted">ייתכן שהקישור שגוי או שהדף הוסר.</p>
        <a routerLink="/" class="btn btn-primary">לדף הבית</a>
      </section>
    } @else if (ended(); as e) {
      <section class="container empty">
        <h1>{{ e.titleHe }}</h1>
        <p class="muted">המבצע הסתיים</p>
        @if (endedTarget(); as t) {
          @if (t.external) {
            <a [href]="t.href" class="btn btn-primary">להמשך קנייה</a>
          } @else {
            <a [routerLink]="t.path" [queryParams]="t.queryParams" [fragment]="t.fragment" class="btn btn-primary"
              >להמשך קנייה</a
            >
          }
        }
      </section>
    } @else if (failed()) {
      <section class="container empty">
        <p class="error" role="alert">לא הצלחנו לטעון את הדף. נסו שוב.</p>
        <button type="button" class="btn btn-secondary" (click)="load(slug(), previewToken())">נסו שוב</button>
      </section>
    } @else if (page(); as p) {
      <article class="container landing">
        <header class="opening">
          <div class="photo" [class.has-mobile]="!!p.mobileImage">
            <hg-banner-image [banner]="p" [priority]="true" />
          </div>
          <div class="titles">
            <h1>{{ p.titleHe }}</h1>
            @if (p.sublineHe) {
              <p class="subline">{{ p.sublineHe }}</p>
            }
          </div>
        </header>
        <hg-rich-text [html]="p.introHtml" />
        @if (p.items.length) {
          <div class="bar">
            <p class="count">
              <bdi>{{ count(p.items.length) }}</bdi>
            </p>
            <label class="sort">
              <span class="muted">מיון</span>
              <select [value]="sort()" (change)="sortChanged($any($event.target).value)">
                @for (s of sorts; track s[0]) {
                  <option [value]="s[0]" [selected]="s[0] === sort()">{{ s[1] }}</option>
                }
              </select>
            </label>
          </div>
          <ul class="product-grid">
            @for (c of sorted(); track c.slug) {
              <li><hg-product-card [product]="c" /></li>
            }
          </ul>
        } @else {
          <p class="muted none">אין כרגע מוצרים להצגה</p>
        }
        @if (p.outroHtml) {
          <div class="outro"><hg-rich-text [html]="p.outroHtml" /></div>
        }
      </article>
    }
  `,
  styles: `
    .preview-strip {
      padding-block: var(--space-2);
      text-align: center;
      font-weight: 700;
      background: var(--color-text);
      color: var(--color-surface);
    }

    .landing {
      display: grid;
      gap: var(--space-5);
      padding-block: var(--space-5) var(--space-7);
    }

    .opening {
      display: grid;
      gap: var(--space-4);
    }

    .photo {
      position: relative;
      overflow: hidden;
      border-radius: var(--radius-lg);
      background: var(--color-surface-alt);
      aspect-ratio: 16 / 9;

      &.has-mobile {
        aspect-ratio: 4 / 5;
      }
    }

    h1 {
      margin: 0;
      font-size: var(--font-display);
    }

    .subline {
      margin: var(--space-2) 0 0;
      font-size: var(--font-h3);
      color: var(--color-text-secondary);
    }

    .bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .count {
      margin: 0;
      color: var(--color-text-secondary);
    }

    .sort {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      font-size: var(--font-small);

      select {
        block-size: 44px;
        border-radius: var(--radius-md);
        border: var(--border-width) solid var(--color-border-strong);
        background: var(--color-surface);
        color: var(--color-text);
        font: inherit;
        font-weight: 600;
        padding-inline: var(--space-3);
        max-inline-size: 12rem;
      }
    }

    .none {
      text-align: center;
      padding-block: var(--space-7);
    }

    .outro {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .empty {
      display: grid;
      justify-items: center;
      gap: var(--space-3);
      text-align: center;
      padding-block: var(--space-9);
    }

    @media (width >= 768px) {
      .photo.has-mobile {
        aspect-ratio: 16 / 9;
      }
    }
  `,
})
export class LandingPage {
  readonly slug = input.required<string>();
  /** Bound from the query string (`?sort=`, `?preview=`). */
  readonly sortParam = input<string | undefined>(undefined, { alias: 'sort' });
  readonly previewToken = input<string | undefined>(undefined, { alias: 'preview' });

  private readonly api = inject(ContentApi);
  private readonly meta = inject(PageMeta);
  private readonly tasks = inject(PendingTasks);
  private readonly router = inject(Router);

  protected readonly page = signal<LandingPageView | null>(null);
  protected readonly preview = signal(false);
  protected readonly ended = signal<LandingEnded | null>(null);
  protected readonly notFound = signal(false);
  protected readonly failed = signal(false);
  protected readonly sorts = Object.entries(LANDING_SORT_LABELS) as [LandingSort, string][];
  protected readonly count = productCount;
  protected readonly sort = computed(() => parseLandingSort(this.sortParam()));
  protected readonly sorted = computed(() => {
    const p = this.page();
    return p ? sortLandingItems(p.items, p.newestOrder, this.sort()) : [];
  });
  protected readonly endedTarget = computed(() => {
    const e = this.ended();
    return e ? linkTarget(e.endedLinkUrl) : null;
  });
  private generation = 0;

  constructor() {
    effect(() => {
      const slug = this.slug();
      const token = this.previewToken();
      untracked(() => this.load(slug, token));
    });
  }

  protected load(slug: string, token: string | undefined): void {
    const generation = ++this.generation;
    void this.tasks.run(async () => {
      this.page.set(null);
      this.ended.set(null);
      this.notFound.set(false);
      this.failed.set(false);
      this.preview.set(false);
      try {
        const res = await this.api.landing(slug, token);
        if (generation !== this.generation) return;
        const p = res.page;
        this.page.set(p);
        this.preview.set(res.state === 'preview');
        this.meta.set({
          title: p.titleHe,
          description: p.metaDescriptionHe ?? p.sublineHe ?? p.titleHe,
          path: `/collection/${p.slug}`,
          image: p.image.url,
          noindex: p.noindex || res.state === 'preview',
        });
      } catch (error) {
        if (generation !== this.generation) return;
        const status = error instanceof HttpErrorResponse ? error.status : 0;
        if (status === 404) {
          this.notFound.set(true);
          this.meta.notFound();
        } else if (status === 410) {
          const body = (error as HttpErrorResponse).error as LandingEnded;
          this.ended.set({ state: 'ended', titleHe: body.titleHe, endedLinkUrl: body.endedLinkUrl });
          this.meta.gone(body.titleHe);
        } else {
          this.failed.set(true);
          this.meta.serverError();
        }
      }
    });
  }

  protected sortChanged(value: string): void {
    const sort = parseLandingSort(value);
    void this.router.navigate([], {
      queryParams: { sort: sort === 'recommended' ? null : sort },
      queryParamsHandling: 'merge',
      replaceUrl: true,
    });
  }
}
