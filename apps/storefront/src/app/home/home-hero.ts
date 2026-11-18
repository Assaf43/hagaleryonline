import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { BannerView, HomeHeroFallback } from '@hg/models';
import { ResponsiveImage } from '../catalog/responsive-image';
import { BannerImage } from './banner-image';
import { BannerLink } from './banner-link';

/** The first live banner, or today's static hero (text, first best seller's photo, two buttons). */
@Component({
  selector: 'hg-home-hero',
  imports: [RouterLink, ResponsiveImage, BannerImage, BannerLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrl: './home-hero.scss',
  template: `
    @let b = banner();
    @if (b) {
      <section class="hero">
        <div class="hero-text">
          <h1 class="display">{{ b.headlineHe }}</h1>
          @if (b.sublineHe) {
            <p class="lead-text">{{ b.sublineHe }}</p>
          }
          @if (b.ctaLabelHe) {
            <div class="ctas">
              <hg-banner-link [url]="b.linkUrl" cls="btn btn-primary">{{ b.ctaLabelHe }}</hg-banner-link>
            </div>
          }
        </div>
        <div class="hero-art banner-art" [class.has-mobile]="!!b.mobileImage">
          @if (b.ctaLabelHe) {
            <hg-banner-image [banner]="b" sizes="(width >= 1024px) 55vw, 100vw" [priority]="true" />
          } @else {
            <hg-banner-link [url]="b.linkUrl" cls="fill">
              <hg-banner-image [banner]="b" sizes="(width >= 1024px) 55vw, 100vw" [priority]="true" />
            </hg-banner-link>
          }
        </div>
      </section>
    } @else {
      @let f = fallback();
      <section class="hero">
        <div class="hero-text">
          <h1 class="display">בית שמרגיש<br />כמו שלכם</h1>
          <p class="lead-text">ספות, כורסאות ואביזרים לסלון, עם מידות מלאות לכל דגם, כדי שתדעו בדיוק מה ייכנס הביתה.</p>
          <div class="ctas">
            @if (f.category; as c) {
              <a [routerLink]="['/category', c.slug]" class="btn btn-primary">לכל ה{{ c.nameHe }}</a>
            }
            @if (f.room; as r) {
              <a [routerLink]="['/room', r.slug]" class="btn btn-secondary">קנייה לפי חדר</a>
            }
          </div>
        </div>
        @if (f.image; as img) {
          <div class="hero-art">
            <hg-responsive-image [image]="img" sizes="(width >= 1024px) 55vw, 100vw" [priority]="true" />
          </div>
        }
      </section>
    }
  `,
})
export class HomeHero {
  readonly banner = input<BannerView | null>(null);
  readonly fallback = input.required<HomeHeroFallback>();
}
