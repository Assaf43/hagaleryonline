import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { HomeCategoryTile } from '@hg/models';
import { ResponsiveImage } from '../catalog/responsive-image';

/** Hand-picked furniture-type tiles, like the tiles of the rooms block. */
@Component({
  selector: 'hg-home-categories',
  imports: [RouterLink, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home-tiles.scss',
  template: `
    <section class="section" [attr.aria-labelledby]="titleHe() ? headingId() : null">
      @if (titleHe()) {
        <div class="section-head">
          <h2 [id]="headingId()">{{ titleHe() }}</h2>
        </div>
      }
      <ul class="types">
        @for (c of categories(); track c.slug) {
          <li>
            <a [routerLink]="['/category', c.slug]" class="type">
              <span class="type-media">
                @if (c.image; as img) {
                  <hg-responsive-image [image]="img" sizes="(width >= 1024px) 16vw, 42vw" />
                }
              </span>
              {{ c.nameHe }}
            </a>
          </li>
        }
      </ul>
    </section>
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class HomeCategories {
  readonly categories = input.required<HomeCategoryTile[]>();
  readonly titleHe = input<string | null>(null);
  readonly headingId = input('categories');
}
