import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { HomeRoom } from '@hg/models';
import { ResponsiveImage } from '../catalog/responsive-image';

/** Rooms with their furniture types (decision 44). */
@Component({
  selector: 'hg-home-rooms',
  imports: [RouterLink, ResponsiveImage],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home-tiles.scss',
  template: `
    @for (r of rooms(); track r.slug) {
      <section class="section" [attr.aria-labelledby]="'room-' + r.slug">
        <div class="section-head">
          <h2 [id]="'room-' + r.slug">{{ r.nameHe }}</h2>
          <a [routerLink]="['/room', r.slug]">לכל המוצרים ל{{ r.nameHe }}</a>
        </div>
        <ul class="types">
          @for (c of r.categories; track c.slug) {
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
    }
  `,
  styles: `
    :host {
      display: contents;
    }
  `,
})
export class HomeRooms {
  readonly rooms = input.required<HomeRoom[]>();
}
