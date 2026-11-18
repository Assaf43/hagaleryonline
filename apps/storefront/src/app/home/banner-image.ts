import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { BannerView } from '@hg/models';

/** A banner photo (fills its positioned parent box): the mobile picture below 768 px when there is one, AVIF then WebP, the alt text of the banner. */
@Component({
  selector: 'hg-banner-image',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let b = banner();
    @let img = b.image;
    @let mob = b.mobileImage;
    <picture>
      @if (mob?.avifSrcset) {
        <source
          media="(width < 768px)"
          type="image/avif"
          [attr.srcset]="mob?.avifSrcset"
          [attr.sizes]="mobileSizes()"
        />
      }
      @if (mob?.srcset) {
        <source media="(width < 768px)" type="image/webp" [attr.srcset]="mob?.srcset" [attr.sizes]="mobileSizes()" />
      }
      @if (img.avifSrcset) {
        <source type="image/avif" [attr.srcset]="img.avifSrcset" [attr.sizes]="sizes()" />
      }
      @if (img.srcset) {
        <source type="image/webp" [attr.srcset]="img.srcset" [attr.sizes]="sizes()" />
      }
      <img
        [src]="img.url"
        [alt]="b.altHe"
        [attr.width]="img.width ?? null"
        [attr.height]="img.height ?? null"
        [attr.loading]="priority() ? 'eager' : 'lazy'"
        [attr.fetchpriority]="priority() ? 'high' : null"
        decoding="async"
      />
    </picture>
  `,
  styles: `
    :host {
      position: absolute;
      inset: 0;
      display: block;
    }

    picture {
      display: contents;
    }

    img {
      position: absolute;
      inset: 0;
      inline-size: 100%;
      block-size: 100%;
      object-fit: cover;
    }
  `,
})
export class BannerImage {
  readonly banner = input.required<Pick<BannerView, 'image' | 'mobileImage' | 'altHe'>>();
  readonly sizes = input('100vw');
  readonly mobileSizes = input('100vw');
  readonly priority = input(false);
}
