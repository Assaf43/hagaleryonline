import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { LucideCircleCheck, LucideCircleX, LucideClock, LucideTruck } from '@lucide/angular';
import type { VariantDetail } from '@hg/models';
import { deliveryText } from '../core/format';

/** One line under the price (PRD-09): icon and wording by fulfillment mode. Home delivery only. */
@Component({
  selector: 'hg-delivery-line',
  imports: [LucideCircleCheck, LucideCircleX, LucideClock, LucideTruck],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <p class="line" [class]="variant().fulfillment">
      @switch (variant().fulfillment) {
        @case ('in_stock') {
          <svg lucideCircleCheck aria-hidden="true"></svg>
        }
        @case ('pre_order') {
          <svg lucideClock aria-hidden="true"></svg>
        }
        @case ('made_to_order') {
          <svg lucideTruck aria-hidden="true"></svg>
        }
        @default {
          <svg lucideCircleX aria-hidden="true"></svg>
        }
      }
      <span>{{ text() }}</span>
    </p>
  `,
  styles: `
    :host {
      display: block;
    }

    .line {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: 0;
      min-block-size: var(--control-height-compact);
    }

    svg {
      flex: none;
      inline-size: var(--icon-size-ui);
      block-size: var(--icon-size-ui);
    }

    .in_stock {
      color: var(--color-success);
    }

    .out_of_stock {
      color: var(--color-text-secondary);
    }
  `,
})
export class DeliveryLine {
  readonly variant = input.required<VariantDetail>();

  protected readonly text = computed(() => deliveryText(this.variant().fulfillment, this.variant().leadTimeDays));
}
