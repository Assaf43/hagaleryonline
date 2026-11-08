import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import type { ImageRef } from '@hg/models';

/**
 * A product photo (NFR-02): AVIF first, then WebP, in the sizes made on upload, loaded lazily
 * unless it is above the fold. Dev placeholders (SVG) have a single URL.
 */
@Component({
  selector: 'hg-responsive-image',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let img = image();
    <picture>
      @if (img.avifSrcset) {
        <source type="image/avif" [attr.srcset]="img.avifSrcset" [attr.sizes]="sizes()" />
      }
      @if (img.srcset) {
        <source type="image/webp" [attr.srcset]="img.srcset" [attr.sizes]="sizes()" />
      }
      <img
        [src]="img.url"
        [alt]="img.altHe"
        [attr.width]="img.width ?? null"
        [attr.height]="img.height ?? null"
        [attr.loading]="priority() ? 'eager' : 'lazy'"
        [attr.fetchpriority]="priority() ? 'high' : null"
        decoding="async"
      />
    </picture>
  `,
  styles: `
    :host,
    picture {
      display: block;
    }

    img {
      inline-size: 100%;
      block-size: 100%;
      object-fit: contain;
    }
  `,
})
export class ResponsiveImage {
  readonly image = input.required<ImageRef>();
  /** The `sizes` attribute: how wide the photo is shown. */
  readonly sizes = input('100vw');
  readonly priority = input(false);
}
