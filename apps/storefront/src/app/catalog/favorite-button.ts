import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { LucideHeart } from '@lucide/angular';
import { FavoritesStore } from '../core/favorites.store';

let nextId = 0;

/**
 * Heart icon button that saves a product on the device (CMP-01, BRAND §9 icon button). The heart is filled
 * while the product is saved; each change is announced politely. Add the class `on-photo` on the host when the
 * button sits on a product photo, so it gets a surface behind it.
 */
@Component({
  selector: 'hg-favorite-button',
  imports: [LucideHeart],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <button
      type="button"
      class="icon-btn"
      [class.on]="pressed()"
      [attr.aria-pressed]="pressed()"
      [attr.aria-label]="pressed() ? 'הסרה מהמועדפים' : 'הוספה למועדפים'"
      [attr.aria-describedby]="productName() ? nameId : null"
      (click)="toggle()"
    >
      <svg lucideHeart aria-hidden="true"></svg>
    </button>
    @if (productName()) {
      <span class="visually-hidden" [id]="nameId">{{ productName() }}</span>
    }
    <span class="visually-hidden" aria-live="polite">{{ announcement() }}</span>
  `,
  styles: `
    :host {
      display: inline-flex;
    }

    .on svg {
      fill: currentColor;
    }

    :host(.on-photo) .icon-btn {
      background: var(--color-surface);

      &:hover {
        background: var(--color-surface-alt);
      }

      svg {
        inline-size: var(--icon-size-ui);
        block-size: var(--icon-size-ui);
      }
    }
  `,
})
export class FavoriteButton {
  readonly productId = input.required<number>();
  /** Model name, read by screen readers as the button's description (the label text stays the same). */
  readonly productName = input<string>('');
  protected readonly nameId = `hg-fav-name-${nextId++}`;

  private readonly favorites = inject(FavoritesStore);
  /** Reads the store's signal, so it follows changes from other buttons and other tabs. */
  protected readonly pressed = computed(() => this.favorites.has(this.productId()));
  protected readonly announcement = signal('');

  protected toggle(): void {
    this.favorites.toggle(this.productId());
    this.announcement.set(this.pressed() ? 'נוסף למועדפים' : 'הוסר מהמועדפים');
  }
}
