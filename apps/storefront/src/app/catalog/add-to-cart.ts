import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  inject,
  input,
  signal,
  viewChild,
} from '@angular/core';
import type { FulfillmentMode } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { QuantityStepper } from './quantity-stepper';

/**
 * The product page's one primary button (CRT-01, BRAND §9.4): a quantity stepper and "הוספה לסל". An
 * out-of-stock choice shows a disabled "אזל מהמלאי". A successful add opens the mini cart; the server
 * clamps the quantity to the real stock and the mini cart shows its notice.
 */
@Component({
  selector: 'hg-add-to-cart',
  imports: [QuantityStepper],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="row">
      @if (canAdd()) {
        <hg-quantity-stepper [value]="quantity()" [max]="max()" (changed)="wanted.set($event)" />
      }
      <button
        #main
        type="button"
        class="btn btn-primary add"
        [disabled]="!canAdd()"
        [attr.aria-busy]="busy() || null"
        (click)="add()"
      >
        {{ canAdd() ? 'הוספה לסל' : 'אזל מהמלאי' }}
      </button>
    </div>
    <p class="error" role="alert">{{ errorMessage() }}</p>
    <span class="visually-hidden" role="status">{{ status() }}</span>
  `,
  styles: `
    :host {
      display: block;
    }

    .row {
      display: flex;
      gap: var(--space-3);
    }

    .add {
      flex: 1;
    }

    .add:disabled {
      background: var(--color-surface-alt);
      color: var(--color-text-secondary);
    }

    .add[aria-busy='true'] {
      cursor: progress;
    }

    .error {
      margin: var(--space-2) 0 0;
      color: var(--color-danger);
      font-size: var(--font-small);

      &:empty {
        display: none;
      }
    }
  `,
})
export class AddToCart {
  /** The chosen variant; null when nothing can be bought. */
  readonly variantId = input<number | null>(null);
  readonly fulfillment = input.required<FulfillmentMode>();
  /** Most units the stepper offers (the server clamps to the real stock). */
  readonly maxQuantity = input(10);

  private readonly cart = inject(CartStore);
  /** The main button, watched by the sticky bar on phones. */
  readonly button = viewChild.required<ElementRef<HTMLButtonElement>>('main');

  protected readonly wanted = signal(1);
  protected readonly max = computed(() => Math.max(1, this.maxQuantity()));
  /** Follows a smaller limit when another variant is chosen. */
  protected readonly quantity = computed(() => Math.min(this.wanted(), this.max()));
  readonly canAdd = computed(() => this.variantId() !== null && this.fulfillment() !== 'out_of_stock');
  protected readonly busy = signal(false);
  private readonly failed = signal(false);
  /** Empty unless the last add failed; the sticky bar shows it too. */
  readonly errorMessage = computed(() => (this.failed() ? 'לא הצלחנו להוסיף לסל. נסו שוב.' : ''));
  /** Polite status, cleared at each try so every success is announced again. */
  protected readonly status = signal('');

  async add(): Promise<void> {
    const id = this.variantId();
    if (id === null || !this.canAdd() || this.busy()) return;
    this.busy.set(true);
    this.failed.set(false);
    this.status.set('');
    try {
      await this.cart.add(id, this.quantity());
      this.status.set('נוסף לסל');
      this.cart.miniCartOpen.set(true);
    } catch {
      this.failed.set(true);
    } finally {
      this.busy.set(false);
    }
  }
}
