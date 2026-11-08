import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { ProductCard as Card } from '@hg/models';
import { deliveryBadge, formatPrice } from '../core/format';
import { ResponsiveImage } from './responsive-image';

const MAX_SWATCHES = 4;

/**
 * Product card for grids (CAT-03, decision 63): a large photo on light gray with delivery and sale
 * badges on it, the English model name in bold with the Hebrew name under it, price and colors.
 */
@Component({
  selector: 'hg-product-card',
  imports: [RouterLink, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let p = product();
    <article class="card">
      <div class="media">
        @if (p.image) {
          <hg-responsive-image [image]="p.image" [sizes]="sizes()" [priority]="priority()" />
        }
        <span class="badges">
          <span class="badge badge-delivery" [class.out]="p.fulfillment === 'out_of_stock'">{{ delivery() }}</span>
          @if (p.discountPercent) {
            <span class="badge badge-dark"
              >מבצע <bdi dir="ltr" class="num">-{{ p.discountPercent }}%</bdi></span
            >
          }
          @if (p.isNew) {
            <span class="badge badge-dark">חדש</span>
          }
        </span>
      </div>
      <div class="body">
        <h3 class="title">
          <a [routerLink]="['/product', p.slug]">
            <bdi dir="ltr" class="model">{{ p.modelName }}</bdi>
            <span class="name">{{ p.nameHe }}</span>
          </a>
        </h3>
        <p class="price-row">
          <span class="price" [class.sale]="p.compareAtFrom">
            @if (p.hasPriceRange) {
              <span class="from">החל מ-</span>
            }
            <span class="num">{{ price(p.priceFrom) }}</span>
          </span>
          @if (p.compareAtFrom) {
            <s class="old-price num"><span class="visually-hidden">במקום </span>{{ price(p.compareAtFrom) }}</s>
          }
        </p>
        @if (p.swatches.length > 1) {
          <p class="swatches" [attr.aria-label]="colorsLabel()">
            @for (s of shownSwatches(); track s.code) {
              <span class="swatch" [style.background]="s.hex" [attr.title]="s.labelHe"></span>
            }
            @if (moreSwatches()) {
              <span class="swatch more" aria-hidden="true">+{{ moreSwatches() }}</span>
            }
          </p>
        }
      </div>
    </article>
  `,
  styles: `
    :host {
      display: block;
    }

    .card {
      position: relative;
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      block-size: 100%;
    }

    .media {
      position: relative;
      aspect-ratio: 1 / 1;
      background: var(--color-surface-alt);
      border-radius: var(--media-radius);
      overflow: hidden;
      display: grid;
      place-items: center;
    }

    hg-responsive-image {
      inline-size: 88%;
      block-size: 88%;
      transition: transform var(--duration-slow) var(--ease);
    }

    .card:hover hg-responsive-image {
      transform: scale(1.04);
    }

    .badges {
      position: absolute;
      inset-block-start: var(--space-3);
      inset-inline-start: var(--space-3);
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: var(--space-1);
    }

    .badge-delivery {
      background: var(--color-surface);
      color: var(--color-text);
      border: var(--border-width) solid var(--color-border);
    }

    .badge-delivery.out {
      color: var(--color-text-secondary);
    }

    .badge-dark {
      background: var(--color-text);
      color: var(--color-bg);
    }

    .body {
      display: grid;
      gap: var(--space-2);
      padding-inline: var(--space-1);
    }

    .title {
      margin: 0;

      a {
        display: grid;
        gap: 2px;
        text-decoration: none;
      }

      // The whole card is clickable through this link.
      a::after {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: var(--card-radius);
      }

      a:focus-visible {
        outline: none;
      }

      a:focus-visible::after {
        outline: var(--focus-ring-width) solid var(--color-focus-ring);
        outline-offset: calc(var(--focus-ring-offset) * 2);
      }
    }

    .model {
      font-size: var(--font-h3);
      font-weight: 800;
      letter-spacing: 0.02em;
      text-transform: uppercase;
      // Left-to-right text, but placed at the start of the right-to-left card.
      justify-self: start;
    }

    .name {
      font-size: var(--font-small);
      font-weight: 400;
      color: var(--color-text-secondary);
    }

    .price-row {
      display: flex;
      flex-wrap: wrap;
      align-items: baseline;
      gap: var(--space-2);
    }

    .price {
      font-weight: 700;
      font-size: var(--font-body);
    }

    .price.sale {
      color: var(--color-sale);
    }

    .from {
      font-weight: 600;
    }

    .old-price {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .swatches {
      display: flex;
      align-items: center;
      gap: var(--space-2);
    }

    .swatch {
      inline-size: var(--swatch-size);
      block-size: var(--swatch-size);
      box-shadow: inset 0 0 0 var(--swatch-ring) var(--color-surface);
    }

    .swatch.more {
      display: inline-grid;
      place-items: center;
      background: var(--color-surface);
      font-size: var(--font-caption);
      font-weight: 600;
      color: var(--color-text);
      box-shadow: none;
    }
  `,
})
export class ProductCard {
  readonly product = input.required<Card>();
  /** Above the fold: load the photo right away. */
  readonly priority = input(false);
  /** How wide the card is shown, for the photo's `sizes`. */
  readonly sizes = input('(width >= 1280px) 25vw, (width >= 768px) 33vw, 50vw');

  protected readonly price = formatPrice;
  protected readonly shownSwatches = computed(() => this.product().swatches.slice(0, MAX_SWATCHES));
  protected readonly moreSwatches = computed(() => Math.max(0, this.product().swatches.length - MAX_SWATCHES));
  protected readonly colorsLabel = computed(
    () =>
      `צבעים: ${this.product()
        .swatches.map((s) => s.labelHe)
        .join(', ')}`,
  );
  protected readonly delivery = computed(() => deliveryBadge(this.product().fulfillment, this.product().leadTimeDays));
}
