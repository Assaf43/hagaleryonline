import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { PageMeta } from '../core/page-meta';

/**
 * `/pay/done` (decision 85): where the payment provider returns after a payment the seller started on the tablet.
 * It shows no order data, no number and no personal details, and names no store (decision 43). noindex, not in the
 * sitemap.
 */
@Component({
  selector: 'hg-pay-done-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container page">
      <h1>התשלום התקבל</h1>
      <p>אישור ההזמנה נשלח אליך במייל. אפשר להחזיר את הטאבלט למוכר.</p>
    </section>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-4);
      padding-block: var(--space-7);
      max-inline-size: 520px;
    }

    h1,
    p {
      margin: 0;
    }
  `,
})
export class PayDonePage {
  constructor() {
    inject(PageMeta).set({
      title: 'התשלום התקבל',
      description: 'התשלום התקבל',
      path: '/pay/done',
      noindex: true,
    });
  }
}
