import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { Router } from '@angular/router';
import type { SandboxPaymentOutcome, SandboxPaymentView } from '@hg/models';
import { formatPrice } from '../core/format';
import { PageMeta } from '../core/page-meta';
import { CheckoutApi, apiErrorCode, checkoutErrorMessage } from '../checkout/checkout.api';

const INSTALLMENTS = Array.from({ length: 12 }, (_, i) => i + 1);

/**
 * The sandbox payment provider's page `/pay/sandbox/:transactionId` (spec §5.3, CHK-10, development only): the
 * amount, an installments choice and three outcomes. The API signs and delivers the matching webhook and answers
 * with the confirmation URL. The page exists only while the sandbox provider is active; otherwise the API's 404
 * is shown. Read in the browser only.
 */
@Component({
  selector: 'hg-sandbox-pay-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <section class="container page">
      <p class="banner" role="note">סביבת בדיקה — אין חיוב אמיתי</p>
      <h1>תשלום</h1>
      @if (loadError(); as e) {
        <p class="error" role="alert">{{ e }}</p>
      } @else if (view(); as v) {
        <div class="card">
          <p class="row">
            <span>הזמנה מספר</span><bdi class="num">{{ v.orderNumber }}</bdi>
          </p>
          <p class="row amount">
            <span>סכום לתשלום</span><span class="num">{{ price(v.amount) }}</span>
          </p>
          @if (v.status !== 'pending') {
            <p class="muted small">התשלום הזה כבר טופל.</p>
          }
          <div class="field">
            <label class="field-label" for="sandbox-installments">מספר תשלומים</label>
            <select id="sandbox-installments" class="input" [value]="installments()" (change)="setInstallments($event)">
              @for (n of installmentOptions; track n) {
                <option [value]="n">{{ n }}</option>
              }
            </select>
          </div>
          <div class="actions">
            <button
              type="button"
              class="btn btn-primary"
              [disabled]="busy() || v.status !== 'pending'"
              (click)="complete('success')"
            >
              תשלום מצליח
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="busy() || v.status !== 'pending'"
              (click)="complete('failure')"
            >
              תשלום נכשל
            </button>
            <button
              type="button"
              class="btn btn-secondary"
              [disabled]="busy() || v.status !== 'pending'"
              (click)="complete('cancel')"
            >
              ביטול
            </button>
          </div>
          <p class="error" role="alert">{{ error() }}</p>
        </div>
      } @else {
        <p class="muted">טוען…</p>
      }
    </section>
  `,
  styles: `
    .page {
      display: grid;
      gap: var(--space-5);
      padding-block: var(--space-5) var(--space-7);
      max-inline-size: 520px;
    }

    h1,
    p {
      margin: 0;
    }

    .banner {
      padding: var(--space-3) var(--space-4);
      background: var(--color-warning-soft);
      color: var(--color-warning);
      border-radius: var(--radius-md);
      font-weight: 700;
    }

    .card {
      display: grid;
      gap: var(--space-4);
      padding: var(--space-5);
      border: var(--border-width) solid var(--color-border);
      border-radius: var(--radius-md);
    }

    .row {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
    }

    .amount {
      font-weight: 700;
      font-size: var(--font-h3);
    }

    .field {
      display: grid;
      gap: var(--space-1);
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: var(--space-3);
    }

    .error {
      color: var(--color-danger);
      font-size: var(--font-small);

      &:empty {
        display: none;
      }
    }
  `,
})
export class SandboxPayPage {
  readonly transactionId = input.required<string>();

  private readonly api = inject(CheckoutApi);
  private readonly router = inject(Router);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));

  protected readonly view = signal<SandboxPaymentView | null>(null);
  protected readonly loadError = signal('');
  protected readonly installments = signal(1);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly installmentOptions = INSTALLMENTS;
  protected readonly price = formatPrice;

  constructor() {
    inject(PageMeta).set({
      title: 'תשלום בסביבת בדיקה',
      description: 'עמוד תשלום לבדיקות בלבד',
      path: '/pay/sandbox',
      noindex: true,
    });
    effect(() => {
      const id = this.transactionId();
      if (this.browser) untracked(() => void this.load(id));
    });
  }

  private async load(id: string): Promise<void> {
    this.view.set(null);
    this.loadError.set('');
    try {
      this.view.set(await this.api.sandboxPayment(id));
    } catch (error) {
      const code = apiErrorCode(error);
      this.loadError.set(code === 'not_found' ? 'העסקה לא נמצאה.' : checkoutErrorMessage(code));
    }
  }

  protected setInstallments(event: Event): void {
    this.installments.set(Number((event.target as HTMLSelectElement).value));
  }

  protected async complete(outcome: SandboxPaymentOutcome): Promise<void> {
    if (this.busy() || this.view()?.status !== 'pending') return;
    this.busy.set(true);
    this.error.set('');
    try {
      const { confirmationUrl } = await this.api.completeSandboxPayment(this.transactionId(), {
        outcome,
        installments: this.installments(),
      });
      await this.router.navigateByUrl(confirmationUrl);
    } catch (error) {
      this.error.set(`לא הצלחנו להשלים את התשלום. ${checkoutErrorMessage(apiErrorCode(error))}`);
    } finally {
      this.busy.set(false);
    }
  }
}
