import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { ORDER_LOOKUP_MISS_HE, SUPPORT_FIELD_MESSAGES_HE } from '@hg/models';
import { CustomerStore } from '../account/customer.store';
import { checkoutErrorMessage } from '../checkout/checkout.api';
import { SupportApi, supportFailure, type SupportOrder } from './support.api';

type StepField = 'number' | 'phone';

const REQUIRED: Record<StepField, string> = {
  number: 'יש להזין את מספר ההזמנה',
  phone: 'יש להזין את מספר הטלפון',
};

/**
 * The first step of the return and damaged-product forms: which order. Signed out: the order number (prefilled from
 * `?order=`) and the phone it was placed with; signed in: the number alone, the session proves the owner. The order is
 * read only in the browser (it depends on the session); on a miss there is one generic message. Emits the order and
 * the reference the support API wants (null when signed in), or `null` when the customer asks to change the order.
 */
@Component({
  selector: 'hg-support-order-step',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './order-step.html',
  styleUrl: './support.scss',
})
export class OrderStep {
  /** The order number from the link (`?order=`), if any. */
  readonly initialNumber = input<string | undefined>(undefined);
  /** Prefix of the element ids. */
  readonly idPrefix = input('os');
  readonly orderChange = output<SupportOrder | null>();

  private readonly api = inject(SupportApi);
  protected readonly store = inject(CustomerStore);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  protected readonly number = signal('');
  protected readonly phone = signal('');
  protected readonly errors = signal<Partial<Record<StepField, string>>>({});
  protected readonly formError = signal('');
  protected readonly busy = signal(false);
  protected readonly current = signal<SupportOrder | null>(null);
  private prefilled = false;

  constructor() {
    effect(() => {
      const initial = this.initialNumber();
      untracked(() => {
        if (initial && !this.number()) this.number.set(initial.trim().slice(0, 20));
      });
    });
    // Signed in with an order number in the link: nothing more to ask.
    effect(() => {
      const ready = this.store.ready();
      const me = this.store.me();
      untracked(() => {
        if (!this.browser || this.prefilled) return;
        if (!ready) {
          void this.store.load();
          return;
        }
        this.prefilled = true;
        if (me && this.number()) void this.load();
      });
    });
  }

  protected id(field: StepField): string {
    return `${this.idPrefix()}-${field}`;
  }

  protected input(field: StepField, event: Event): void {
    (field === 'number' ? this.number : this.phone).set((event.target as HTMLInputElement).value);
    this.formError.set('');
    if (this.errors()[field]) this.errors.update((e) => ({ ...e, [field]: undefined }));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.load();
  }

  protected change(): void {
    this.current.set(null);
    this.orderChange.emit(null);
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${this.id('number')}`)?.focus(), {
      injector: this.injector,
    });
  }

  private async load(): Promise<void> {
    if (this.busy()) return;
    this.formError.set('');
    const signedIn = this.store.me() !== null;
    const number = this.number().trim();
    const phone = this.phone().trim();
    const errors: Partial<Record<StepField, string>> = {};
    if (!number) errors.number = REQUIRED.number;
    if (!signedIn && !phone) errors.phone = REQUIRED.phone;
    this.errors.set(errors);
    const first = (['number', 'phone'] as const).find((f) => errors[f]);
    if (first) {
      afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${this.id(first)}`)?.focus(), {
        injector: this.injector,
      });
      return;
    }
    this.busy.set(true);
    try {
      const result = await this.api.loadOrder(number, signedIn ? null : phone);
      this.current.set(result);
      this.orderChange.emit(result);
    } catch (error) {
      if (signedIn && this.store.unauthorized(error)) return;
      const failure = supportFailure(error);
      this.formError.set(
        failure.status === 404
          ? ORDER_LOOKUP_MISS_HE
          : failure.status === 429
            ? checkoutErrorMessage('too_many_requests')
            : failure.status === 400
              ? SUPPORT_FIELD_MESSAGES_HE.order
              : checkoutErrorMessage(null),
      );
    } finally {
      this.busy.set(false);
    }
  }
}
