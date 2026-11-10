import { ChangeDetectionStrategy, Component, computed, input, output } from '@angular/core';
import { LucideMinus, LucidePlus } from '@lucide/angular';

/**
 * Quantity stepper (BRAND §9.4), shared by the product page and the cart page. The buttons stay focusable at a
 * bound (aria-disabled), so a keyboard user keeps their place; the number is announced politely.
 */
@Component({
  selector: 'hg-quantity-stepper',
  imports: [LucideMinus, LucidePlus],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stepper" role="group" [attr.aria-label]="label()">
      <button
        type="button"
        class="step"
        aria-label="הקטנת הכמות"
        [attr.aria-disabled]="value() <= 1"
        (click)="step(-1)"
      >
        <svg lucideMinus aria-hidden="true"></svg>
      </button>
      <span class="qty num" aria-live="polite">{{ value() }}</span>
      <button
        type="button"
        class="step"
        aria-label="הגדלת הכמות"
        [attr.aria-disabled]="value() >= maxValue()"
        (click)="step(1)"
      >
        <svg lucidePlus aria-hidden="true"></svg>
      </button>
    </div>
  `,
  styles: `
    :host {
      display: inline-block;
      flex: none;
    }

    .stepper {
      display: inline-flex;
      align-items: stretch;
      block-size: var(--control-height);
      border: var(--border-width) solid var(--color-border-strong);
      border-radius: var(--radius-md);
    }

    .step {
      display: inline-grid;
      place-items: center;
      inline-size: var(--icon-button-size);
      block-size: var(--control-height);
      background: none;
      border: none;
      color: var(--color-text);

      &[aria-disabled='true'] {
        color: var(--color-text-muted);
        cursor: default;
      }

      svg {
        inline-size: var(--icon-size-md);
        block-size: var(--icon-size-md);
      }
    }

    .qty {
      align-self: center;
      min-inline-size: var(--space-6);
      text-align: center;
      font-weight: 600;
    }
  `,
})
export class QuantityStepper {
  readonly value = input.required<number>();
  /** Most units offered. */
  readonly max = input.required<number>();
  readonly label = input('כמות');
  /** The new quantity, only when it stays within 1..max. */
  readonly changed = output<number>();

  protected readonly maxValue = computed(() => Math.max(1, this.max()));

  protected step(delta: 1 | -1): void {
    const next = this.value() + delta;
    if (next < 1 || next > this.maxValue()) return;
    this.changed.emit(next);
  }
}
