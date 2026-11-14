import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  inject,
  signal,
} from '@angular/core';
import { HttpErrorResponse } from '@angular/common/http';
import { Router } from '@angular/router';
import { ORDER_LOOKUP_MISS_HE } from '@hg/models';
import { PageMeta } from '../core/page-meta';
import { CheckoutApi, apiErrorCode, checkoutErrorMessage } from '../checkout/checkout.api';

type LookupField = 'number' | 'phone';

/** Element ids of the two fields; an error is `<id>-error`. */
const IDS: Record<LookupField, string> = { number: 'os-number', phone: 'os-phone' };

const REQUIRED: Record<LookupField, string> = {
  number: 'יש להזין את מספר ההזמנה',
  phone: 'יש להזין את מספר הטלפון',
};

/**
 * "My order status" `/order-status` (spec §6.5, SHP-05): the order number and the phone it was placed with open the
 * order page (`/order/:number?t=`, the order's own link). Anything that is not a match shows one generic message; the
 * API limits the attempts per IP and per order number. Nothing is personal before the customer asks, so the server
 * renders the whole form; it is `noindex` and never in the sitemap.
 */
@Component({
  selector: 'hg-order-status-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-status.page.html',
  styleUrl: './order-status.page.scss',
})
export class OrderStatusPage {
  private readonly api = inject(CheckoutApi);
  private readonly router = inject(Router);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly ids = IDS;
  protected readonly number = signal('');
  protected readonly phone = signal('');
  protected readonly errors = signal<Partial<Record<LookupField, string>>>({});
  /** The answer of the last lookup that found nothing (or failed); announced. */
  protected readonly formError = signal('');
  protected readonly busy = signal(false);

  constructor() {
    inject(PageMeta).set({
      title: 'מצב ההזמנה שלי',
      description: 'בדיקת מצב ההזמנה לפי מספר ההזמנה ומספר הטלפון',
      path: '/order-status',
      noindex: true,
    });
  }

  protected input(field: LookupField, event: Event): void {
    (field === 'number' ? this.number : this.phone).set((event.target as HTMLInputElement).value);
    this.formError.set('');
    if (this.errors()[field]) this.errors.update((e) => ({ ...e, [field]: undefined }));
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.busy()) return;
    this.formError.set('');
    const number = this.number().trim();
    const phone = this.phone().trim();
    const errors: Partial<Record<LookupField, string>> = {};
    if (!number) errors.number = REQUIRED.number;
    if (!phone) errors.phone = REQUIRED.phone;
    this.errors.set(errors);
    const first = (['number', 'phone'] as const).find((f) => errors[f]);
    if (first) {
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${IDS[first]}`)?.focus(), {
        injector: this.injector,
      });
      return;
    }
    this.busy.set(true);
    try {
      const { url } = await this.api.lookupOrder({ number, phone });
      await this.router.navigateByUrl(url);
    } catch (error) {
      this.busy.set(false);
      this.formError.set(this.failure(error));
    }
  }

  private failure(error: unknown): string {
    const code = apiErrorCode(error);
    if (code === 'not_found') {
      const body = error instanceof HttpErrorResponse ? (error.error as { messageHe?: unknown }) : {};
      return typeof body.messageHe === 'string' ? body.messageHe : ORDER_LOOKUP_MISS_HE;
    }
    if (code === 'too_many_requests') return checkoutErrorMessage(code);
    return checkoutErrorMessage(null);
  }
}
