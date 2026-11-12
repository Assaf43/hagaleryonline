import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { formatPriceNumber } from '@hg/models';

/**
 * A discount amount, "−150 ₪" (owner ruling R20): the signed number is isolated left-to-right, so the minus sits at
 * the left of the digits in the Hebrew (RTL) page, and the ₪ stays where every other price on the site has it.
 */
@Component({
  selector: 'hg-discount-amount',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'num' },
  template: `<bdi dir="ltr">−{{ number() }}</bdi
    >&ngsp;₪`,
})
export class DiscountAmount {
  /** Agorot, positive. */
  readonly amount = input.required<number>();
  protected readonly number = computed(() => formatPriceNumber(this.amount()));
}
