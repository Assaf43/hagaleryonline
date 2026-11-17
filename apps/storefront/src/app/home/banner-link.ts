import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { linkTarget } from './link-target';

/** A link to a banner's `linkUrl`: external (`https:`, `mailto:`, `tel:`) in the same tab, a site path via the router. */
@Component({
  selector: 'hg-banner-link',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @let t = target();
    @if (t.external) {
      <a [href]="t.href" rel="noopener" [class]="cls()"><ng-content /></a>
    } @else {
      <a [routerLink]="t.path" [queryParams]="t.queryParams" [fragment]="t.fragment" [class]="cls()"><ng-content /></a>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    a.card {
      display: grid;
      gap: var(--space-3);
      color: inherit;
      text-decoration: none;
    }

    a.fill {
      display: block;
      block-size: 100%;
      color: inherit;
    }

    a:focus-visible {
      outline: var(--focus-ring-width) solid var(--color-focus-ring);
      outline-offset: var(--focus-ring-offset);
    }
  `,
})
export class BannerLink {
  readonly url = input.required<string>();
  readonly cls = input('');
  protected readonly target = computed(() => linkTarget(this.url()));
}
