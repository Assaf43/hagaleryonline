import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { formatPrice } from '../core/format';

/** Below the desktop breakpoint (BRAND §6). */
const MOBILE_QUERY = '(width < 1024px)';

/**
 * Sticky add-to-cart bar (BRAND §9.4, built in Phase 4): phones only, shown while the page's main
 * "הוספה לסל" button is out of view, so only one of the two is visible at a time. The page wires `buy` to the
 * main block, so both add the same variant and quantity. Browser only (IntersectionObserver).
 */
@Component({
  selector: 'hg-sticky-buy-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (shown()) {
      <div class="sticky-bar">
        <span class="price num">{{ priceText() }}</span>
        <button type="button" class="btn btn-primary" [disabled]="disabled()" (click)="buy.emit()">
          {{ disabled() ? 'אזל מהמלאי' : 'הוספה לסל' }}
        </button>
      </div>
    }
  `,
  styles: `
    :host {
      display: contents;
    }

    .sticky-bar {
      position: fixed;
      inset-inline: 0;
      inset-block-end: 0;
      z-index: 9;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-4);
      padding-block: var(--space-3) calc(var(--space-3) + env(safe-area-inset-bottom));
      padding-inline: var(--gutter);
      background: var(--color-surface);
      border-block-start: var(--border-width) solid var(--color-border);
      box-shadow: var(--shadow-sticky);
    }

    .price {
      font-size: var(--font-price);
      font-weight: 700;
    }

    .btn {
      flex: 1;
      max-inline-size: 280px;
    }

    .btn:disabled {
      background: var(--color-surface-alt);
      color: var(--color-text-secondary);
    }

    @media (width >= 1024px) {
      .sticky-bar {
        display: none;
      }
    }
  `,
})
export class StickyBuyBar {
  /** The main add-to-cart button. */
  readonly target = input<Element | undefined>();
  readonly price = input.required<number>();
  readonly disabled = input(false);
  readonly buy = output<void>();

  private readonly mobile = signal(false);
  private readonly mainOutOfView = signal(false);
  protected readonly shown = computed(() => this.mobile() && this.mainOutOfView());
  protected readonly priceText = computed(() => formatPrice(this.price()));

  constructor() {
    if (!isPlatformBrowser(inject(PLATFORM_ID))) return;
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const el = this.target();
      if (!el || typeof IntersectionObserver === 'undefined' || typeof matchMedia === 'undefined') return;
      const media = matchMedia(MOBILE_QUERY);
      const follow = () => this.mobile.set(media.matches);
      follow();
      media.addEventListener?.('change', follow);
      const observer = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) this.mainOutOfView.set(!entry.isIntersecting);
      });
      observer.observe(el);
      destroyRef.onDestroy(() => {
        observer.disconnect();
        media.removeEventListener?.('change', follow);
      });
    });
  }
}
