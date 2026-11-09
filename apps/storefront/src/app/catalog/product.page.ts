import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PendingTasks,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { HttpErrorResponse } from '@angular/common/http';
import { ActivatedRoute, Router, RouterLink, type ParamMap } from '@angular/router';
import { LucideChevronLeft } from '@lucide/angular';
import type { ProductDetail, VariantDetail } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { PageMeta } from '../core/page-meta';
import { DeliveryLine } from './delivery-line';
import { FavoriteButton } from './favorite-button';
import { galleryImages } from './gallery-images';
import { PriceBlock } from './price-block';
import { ProductDetails } from './product-details';
import { ProductGallery } from './product-gallery';
import { VariantPicker } from './variant-picker';
import {
  adjustmentNotice,
  optionStates,
  paramsToSelection,
  pickOption,
  resolveSelection,
  selectionToParams,
} from './variant-selection';

function toRecord(map: ParamMap): Record<string, string | undefined> {
  return Object.fromEntries(map.keys.map((k) => [k, map.get(k) ?? undefined]));
}

/**
 * Product page (PRD-01..05, PRD-09): the chosen variant lives in the URL (`?color=green&size=280`),
 * so a shared link opens the same variant, also in the server render. The details accordion (PRD-06, PRD-08, PRD-10) sits under the delivery line.
 */
@Component({
  selector: 'hg-product-page',
  imports: [
    RouterLink,
    LucideChevronLeft,
    ProductGallery,
    VariantPicker,
    PriceBlock,
    DeliveryLine,
    ProductDetails,
    FavoriteButton,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container page">
      @if (notFound()) {
        <div class="missing">
          <h1>המוצר לא נמצא</h1>
          <a routerLink="/" class="btn btn-secondary">לדף הבית</a>
        </div>
      } @else if (loadFailed()) {
        <div class="missing" role="alert">
          <p class="error">לא הצלחנו לטעון את המוצר. נסו שוב.</p>
          <button type="button" class="btn btn-secondary" (click)="retry()">נסו שוב</button>
        </div>
      } @else if (product(); as p) {
        @if (variant(); as v) {
          <nav aria-label="פירורי לחם" class="crumbs-wrap">
            <ol class="crumbs">
              <li>
                <a routerLink="/">בית</a>
                <svg lucideChevronLeft aria-hidden="true"></svg>
              </li>
              @for (c of p.breadcrumbs; track c.slug) {
                <li>
                  <a [routerLink]="['/category', c.slug]">{{ c.nameHe }}</a>
                  <svg lucideChevronLeft aria-hidden="true"></svg>
                </li>
              }
              <li aria-current="page">{{ p.nameHe }}</li>
            </ol>
          </nav>

          <div class="layout">
            <hg-product-gallery [images]="gallery()" [label]="p.nameHe" />

            <div class="details">
              <div class="title-row">
                <h1 class="title">
                  <bdi dir="ltr" class="model">{{ p.modelName }}</bdi>
                  <span class="name">{{ p.nameHe }}</span>
                </h1>
                <hg-favorite-button [productId]="p.id" />
              </div>

              <hg-price-block [variant]="v" />

              @if (visibleAxes().length) {
                <hg-variant-picker
                  [axes]="visibleAxes()"
                  [current]="v"
                  [states]="states()"
                  [notice]="notice()"
                  (picked)="pick($event.axis, $event.value)"
                />
              }

              <hg-delivery-line [variant]="v" />

              <!-- Reserved (Phase 4): the product's one primary "הוספה לסל" button and the sticky mobile bar. -->

              <hg-product-details [product]="p" [variant]="v" />
            </div>
          </div>
        }
      }
    </div>
  `,
  styles: `
    .page {
      padding-block-end: var(--space-7);
    }

    .missing {
      display: grid;
      justify-items: start;
      gap: var(--space-4);
      padding-block: var(--space-6);
    }

    .error {
      margin: 0;
    }

    .layout {
      display: grid;
      gap: var(--space-5);
    }

    .details {
      display: grid;
      align-content: start;
      gap: var(--space-4);
      min-inline-size: 0;
    }

    .title-row {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .title {
      display: grid;
      justify-items: start;
      gap: var(--space-1);
      margin: 0;
    }

    .model {
      font-size: var(--font-h2);
      font-weight: 800;
      text-transform: uppercase;
      justify-self: start;
    }

    .name {
      font-size: var(--font-body);
      font-weight: 400;
      color: var(--color-text-secondary);
    }

    @media (width >= 1024px) {
      .layout {
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: var(--space-7);
        align-items: start;
      }

      .details {
        position: sticky;
        inset-block-start: var(--space-5);
      }
    }
  `,
})
export class ProductPage {
  readonly slug = input.required<string>();

  private readonly api = inject(CatalogApi);
  private readonly meta = inject(PageMeta);
  private readonly tasks = inject(PendingTasks);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  readonly product = signal<ProductDetail | null>(null);
  /** The variant the URL (or the last pick) resolves to. */
  readonly variant = signal<VariantDetail | null>(null);
  /** Shown when the picked combination was not available and the choice moved. */
  readonly notice = signal<string | null>(null);
  protected readonly notFound = signal(false);
  /** The API failed with something other than 404 (PRD error state): a message and a retry button. */
  protected readonly loadFailed = signal(false);

  /** Axes with a real choice; a single-value axis needs no buttons. */
  protected readonly visibleAxes = computed(() =>
    (this.product()?.optionAxes ?? []).filter((a) => a.values.length > 1),
  );
  protected readonly states = computed(() => {
    const p = this.product();
    const v = this.variant();
    return p && v ? optionStates(p.variants, p.optionAxes, v) : {};
  });
  /** One array per variant, so the gallery keeps its place while the page re-renders. */
  protected readonly gallery = computed(() => {
    const p = this.product();
    const v = this.variant();
    return p && v ? galleryImages(p, v) : [];
  });

  constructor() {
    // Back/forward or a pasted link while the page is open: follow the URL. Our own picks write the
    // chosen variant to the URL, so they resolve to the variant already shown and change nothing.
    this.route.queryParamMap.pipe(takeUntilDestroyed(inject(DestroyRef))).subscribe((map) => {
      const p = this.product();
      // Ignore emissions while a different product is being loaded (the component is reused).
      if (!p || p.slug !== this.slug()) return;
      const { variant } = resolveSelection(p.variants, p.optionAxes, paramsToSelection(toRecord(map), p.optionAxes));
      if (variant.sku !== this.variant()?.sku) {
        this.variant.set(variant);
        this.notice.set(null);
        this.updateMeta();
      }
    });
    // The router reuses this component from one product to another, so the load follows `slug`.
    effect(() => {
      const slug = this.slug();
      untracked(() => this.load(slug));
    });
  }

  private load(slug: string): void {
    this.product.set(null);
    this.variant.set(null);
    this.notice.set(null);
    this.notFound.set(false);
    this.loadFailed.set(false);
    void this.tasks.run(async () => {
      try {
        const p = await this.api.product(slug);
        if (this.slug() !== slug) return; // the user already moved on to another product
        // A product without variants cannot be shown or bought: same as not found.
        if (!p.variants.length) return this.missing();
        const wanted = paramsToSelection(toRecord(this.route.snapshot.queryParamMap), p.optionAxes);
        this.product.set(p);
        this.variant.set(resolveSelection(p.variants, p.optionAxes, wanted).variant);
        this.updateMeta();
      } catch (e) {
        if (this.slug() !== slug) return;
        if (e instanceof HttpErrorResponse && e.status === 404) this.missing();
        else this.failed();
      }
    });
  }

  protected retry(): void {
    this.load(this.slug());
  }

  protected pick(axis: string, value: string): void {
    const p = this.product();
    const current = this.variant();
    if (!p || !current) return;
    const { variant, adjusted } = pickOption(p.variants, p.optionAxes, current, axis, value);
    this.variant.set(variant);
    this.notice.set(adjustmentNotice(adjusted, p.optionAxes, variant));
    this.updateMeta();
    void this.router.navigate([], {
      queryParams: selectionToParams(variant, p.optionAxes),
      queryParamsHandling: '',
      replaceUrl: true,
    });
  }

  private missing(): void {
    this.notFound.set(true);
    this.meta.notFound();
  }

  private failed(): void {
    this.loadFailed.set(true);
    this.meta.serverError();
  }

  private updateMeta(): void {
    const p = this.product();
    const v = this.variant();
    if (!p || !v) return;
    this.meta.set({
      title: p.nameHe,
      description:
        p.descriptionHe
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 160) || p.nameHe,
      path: `/product/${p.slug}`, // canonical without the variant params
      image: this.gallery()[0]?.url,
    });
  }
}
