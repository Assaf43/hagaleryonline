import { ChangeDetectionStrategy, Component, OnInit, inject, signal } from '@angular/core';
import type { ProvidersStatus } from '@hg/models';
import { errorMessage } from '../core/errors';
import { OrdersApi } from '../core/orders.api';

/** Active payment and shipping providers and whether payments are in test mode (spec §5.5, ADM-13). Read-only. */
@Component({
  selector: 'hga-providers-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <h1>ספקים</h1>
    <p class="page-intro">הספקים הפעילים באתר. המעבר לספק אחר נעשה בהגדרות השרת; מתגי הפעלה יתווספו כשיהיה ספק שני.</p>
    @if (error()) {
      <p class="form-error" role="alert">{{ error() }}</p>
    }
    @if (status(); as s) {
      <section class="panel" aria-labelledby="payment-title">
        <h2 id="payment-title">תשלומים</h2>
        <p>
          ספק פעיל: <bdi dir="ltr" class="code">{{ s.payment.code }}</bdi>
          @if (s.payment.testMode) {
            <span class="badge test">מצב בדיקה</span>
          }
        </p>
        @if (s.payment.testMode) {
          <p class="muted">במצב בדיקה לא עובר כסף אמיתי. אסור להפעיל חנות אמיתית במצב הזה.</p>
        }
      </section>
      <section class="panel" aria-labelledby="shipping-title">
        <h2 id="shipping-title">משלוחים</h2>
        <p>
          ספק פעיל: <bdi dir="ltr" class="code">{{ s.shipping.code }}</bdi>
        </p>
      </section>
    }
  `,
  styles: `
    :host {
      display: grid;
      gap: var(--space-4);
      align-content: start;
    }

    h1,
    h2,
    p {
      margin: 0;
    }

    h2 {
      font-size: var(--font-h3);
    }

    .page-intro {
      margin-block-end: 0;
    }

    .muted {
      color: var(--color-text-secondary);
      font-size: var(--font-small);
    }

    .badge {
      margin-inline-start: var(--space-2);
      padding: var(--badge-padding-block) var(--badge-padding-inline);
      font-size: var(--font-small);
      border-radius: var(--radius-pill);
    }

    .badge.test {
      color: var(--color-warning);
      background: var(--color-warning-soft);
    }
  `,
})
export class ProvidersPage implements OnInit {
  private readonly api = inject(OrdersApi);
  protected readonly status = signal<ProvidersStatus | null>(null);
  protected readonly error = signal('');

  async ngOnInit() {
    try {
      this.status.set(await this.api.providers());
    } catch (e) {
      this.error.set(errorMessage(e));
    }
  }
}
