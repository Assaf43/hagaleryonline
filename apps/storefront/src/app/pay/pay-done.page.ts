import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
} from '@angular/core';
import { PageMeta } from '../core/page-meta';

const COPY = {
  ok: {
    title: 'התשלום התקבל',
    text: 'אישור ההזמנה נשלח אליך במייל. אפשר להחזיר את הטאבלט למוכר.',
  },
  fail: {
    title: 'התשלום לא הושלם',
    text: 'לא חויבת. אפשר להחזיר את הטאבלט למוכר כדי לנסות שוב.',
  },
  unknown: {
    title: 'סיימת בדף התשלום',
    text: 'אפשר להחזיר את הטאבלט למוכר. אם התשלום הצליח, אישור ההזמנה יישלח אליך במייל.',
  },
};

/**
 * `/pay/done` (decision 85): where the payment provider returns after a payment the seller started on the tablet.
 * The only input is the outcome `?r=ok|fail` (the provider's success or failure/cancel return); anything else gets
 * neutral copy. It shows no order data, no number and no personal details, and names no store (decision 43).
 * noindex, not in the sitemap.
 */
@Component({
  selector: 'hg-pay-done-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container page">
      <h1 tabindex="-1">{{ copy().title }}</h1>
      <p>{{ copy().text }}</p>
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
  /** The outcome from the query string (`?r=`); read as-is, never trusted beyond choosing the copy. */
  readonly r = input<string | undefined>(undefined);
  protected readonly copy = computed(() =>
    this.r() === 'ok' ? COPY.ok : this.r() === 'fail' ? COPY.fail : COPY.unknown,
  );

  constructor() {
    const host = inject<ElementRef<HTMLElement>>(ElementRef);
    const meta = inject(PageMeta);
    effect(() => {
      const title = this.copy().title;
      meta.set({ title, description: title, path: '/pay/done', noindex: true });
    });
    afterNextRender(() => host.nativeElement.querySelector('h1')?.focus());
  }
}
