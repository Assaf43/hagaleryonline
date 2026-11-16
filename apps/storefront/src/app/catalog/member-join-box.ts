import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map } from 'rxjs';
import type { VariantDetail } from '@hg/models';
import { formatPrice } from '../core/format';
import { MEMBER_JOIN_LINK_HE, MEMBER_JOIN_PREFIX_HE, Viewer, memberPriceView } from './member-price';

/**
 * Product page box for a guest (option A): "חברי מועדון משלמים <price>. התחברות או הצטרפות". It exists only in the
 * browser once the viewer is known to be a guest; the link returns to this product (with its variant) after sign-in.
 */
@Component({
  selector: 'hg-member-join-box',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (view().joinLink) {
      <p class="box">
        {{ prefix }} <bdi class="num">{{ price() }}</bdi
        >.
        <a [routerLink]="['/account']" [queryParams]="{ next: next() }">{{ link }}</a>
      </p>
    }
  `,
  styles: `
    :host {
      display: block;
    }

    .box {
      margin: 0;
      padding: var(--space-3) var(--space-4);
      background: var(--color-surface-alt);
      border-radius: var(--radius-md);
      font-size: var(--font-small);
    }

    a {
      font-weight: 600;
      color: var(--color-text);
      text-decoration: underline;
    }
  `,
})
export class JoinBox {
  readonly variant = input.required<VariantDetail>();

  private readonly router = inject(Router);
  private readonly viewer = inject(Viewer);
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e) => e instanceof NavigationEnd),
      map(() => this.router.url),
    ),
    { initialValue: this.router.url },
  );
  protected readonly prefix = MEMBER_JOIN_PREFIX_HE;
  protected readonly link = MEMBER_JOIN_LINK_HE;
  protected readonly next = computed(() => this.url());
  protected readonly view = computed(() => {
    const v = this.variant();
    return memberPriceView(v.price, v.compareAtPrice, v.memberPrice, this.viewer.isMember());
  });
  protected readonly price = computed(() => formatPrice(this.variant().memberPrice ?? 0));
}
