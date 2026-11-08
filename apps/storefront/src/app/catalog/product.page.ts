import { ChangeDetectionStrategy, Component, PendingTasks, computed, inject, input, signal } from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { RouterLink } from '@angular/router';
import type { ProductDetail } from '@hg/models';
import { CatalogApi } from '../core/catalog.api';
import { formatPrice } from '../core/format';
import { PageMeta } from '../core/page-meta';
import { ResponsiveImage } from './responsive-image';

/**
 * Temporary product page so the cards lead somewhere (Phase 3a). The full page — gallery,
 * variant choice, dimensions, delivery — is Phase 3b.
 */
@Component({
  selector: 'hg-product-page',
  imports: [RouterLink, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="container page">
      @if (notFound()) {
        <h1>המוצר לא נמצא</h1>
        <a routerLink="/" class="btn btn-primary">לדף הבית</a>
      } @else if (product(); as p) {
        @if (p.images[0] ?? p.variants[0]?.images?.[0]; as img) {
          <div class="media">
            <hg-responsive-image [image]="img" sizes="(width >= 1024px) 50vw, 100vw" [priority]="true" />
          </div>
        }
        <div>
          <h1>{{ p.nameHe }}</h1>
          <p class="price num">{{ priceFrom() }}</p>
          <p class="muted">דף המוצר המלא, עם בחירת צבע ומידה, יגיע בשלב הבא.</p>
        </div>
      }
    </div>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-5);
      padding-block: var(--space-6);
    }

    @media (width >= 1024px) {
      .page {
        grid-template-columns: 1fr 1fr;
      }
    }

    .media {
      background: var(--color-surface-alt);
      border-radius: var(--radius-lg);
      aspect-ratio: 4 / 3;
      overflow: hidden;
    }

    .price {
      font-size: var(--font-price);
      font-weight: 700;
      margin-block: var(--space-3);
    }
  `,
})
export class ProductPage {
  readonly slug = input.required<string>();

  private readonly api = inject(CatalogApi);
  private readonly meta = inject(PageMeta);
  protected readonly product = signal<ProductDetail | null>(null);
  protected readonly notFound = signal(false);
  protected readonly priceFrom = computed(() => {
    const prices = this.product()?.variants.map((v) => v.price) ?? [];
    return prices.length ? formatPrice(Math.min(...prices)) : '';
  });

  private readonly tasks = inject(PendingTasks);

  ngOnInit() {
    void this.tasks.run(async () => {
      try {
        const p = await this.api.product(this.slug());
        this.product.set(p);
        this.meta.set({
          title: p.nameHe,
          description:
            p.descriptionHe
              .replace(/<[^>]+>/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 160) || p.nameHe,
          path: `/product/${p.slug}`,
          image: p.images[0]?.url,
        });
      } catch (e) {
        if (e instanceof HttpErrorResponse && e.status === 404) {
          this.notFound.set(true);
          this.meta.notFound();
        }
      }
    });
  }
}
