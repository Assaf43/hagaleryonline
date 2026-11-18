import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProductCard as Card } from '@hg/models';
import { ProductCard } from '../catalog/product-card';

/** A product row, with a "לכל המוצרים" link when the source has a listing page. */
@Component({
  selector: 'hg-home-products',
  imports: [RouterLink, ProductCard],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="section" [attr.aria-labelledby]="titleHe() ? headingId() : null">
      @if (titleHe() || link()) {
        <div class="section-head">
          @if (titleHe()) {
            <h2 [id]="headingId()">{{ titleHe() }}</h2>
          }
          @if (link(); as l) {
            <a [routerLink]="l">לכל המוצרים</a>
          }
        </div>
      }
      <ul class="product-grid four">
        @for (p of items(); track p.slug) {
          <li><hg-product-card [product]="p" /></li>
        }
      </ul>
    </section>
  `,
  styles: `
    :host {
      display: contents;
    }

    .product-grid.four {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    @media (width >= 1024px) {
      .product-grid.four {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
    }
  `,
})
export class HomeProducts {
  readonly items = input.required<Card[]>();
  readonly titleHe = input<string | null>(null);
  readonly link = input<string | null>(null);
  readonly headingId = input('products');
}
