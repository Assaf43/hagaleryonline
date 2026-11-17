import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { BannerView } from '@hg/models';
import { BannerImage } from './banner-image';
import { BannerLink } from './banner-link';

/** One or two banners side by side (one: full width). The whole card is the link. */
@Component({
  selector: 'hg-home-banner-pair',
  imports: [BannerImage, BannerLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="section" [attr.aria-labelledby]="titleHe() ? headingId() : null">
      @if (titleHe()) {
        <div class="section-head">
          <h2 [id]="headingId()">{{ titleHe() }}</h2>
        </div>
      }
      <ul class="pair" [class.single]="banners().length === 1">
        @for (b of banners(); track b.id) {
          <li>
            <hg-banner-link [url]="b.linkUrl" cls="card">
              <span class="media">
                <hg-banner-image
                  [banner]="b"
                  [sizes]="banners().length === 1 ? '100vw' : '(width >= 768px) 50vw, 100vw'"
                />
              </span>
              <span class="text">
                <strong class="headline">{{ b.headlineHe }}</strong>
                @if (b.sublineHe) {
                  <span class="subline">{{ b.sublineHe }}</span>
                }
                @if (b.ctaLabelHe) {
                  <span class="btn btn-secondary">{{ b.ctaLabelHe }}</span>
                }
              </span>
            </hg-banner-link>
          </li>
        }
      </ul>
    </section>
  `,
  styles: `
    :host {
      display: contents;
    }

    .pair {
      list-style: none;
      margin: 0;
      padding: 0;
      display: grid;
      gap: var(--space-4);
    }

    .media {
      display: block;
      aspect-ratio: 4 / 3;
      background: var(--color-surface-alt);
      border-radius: var(--media-radius);
      overflow: hidden;
    }

    .text {
      display: grid;
      gap: var(--space-2);
      justify-items: start;
    }

    .headline {
      font-size: var(--font-h3);
    }

    .subline {
      color: var(--color-text-secondary);
    }

    @media (width >= 768px) {
      .pair:not(.single) {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }

      .single .media {
        aspect-ratio: 21 / 9;
      }
    }
  `,
})
export class HomeBannerPair {
  readonly banners = input.required<BannerView[]>();
  readonly titleHe = input<string | null>(null);
  readonly headingId = input('banner-pair');
}
