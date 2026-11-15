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
  computed,
  signal,
  untracked,
} from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import {
  ORDER_LOOKUP_MISS_HE,
  ORDER_NUMBER_MAX_LENGTH,
  PHONE_INPUT_MAX_LENGTH,
  SUPPORT_FIELD_MESSAGES_HE,
} from '@hg/models';
import { CustomerStore } from '../account/customer.store';
import { checkoutErrorMessage } from '../checkout/checkout.api';
import { SupportApi, supportFailure, type SupportOrder } from './support.api';

type StepField = 'number' | 'phone';

/** Signed in, and the account has no such order: a guest order needs its phone. */
export const GUEST_ORDER_HINT_HE = 'לא מצאנו את ההזמנה בחשבון שלכם. אם הזמנתם כאורח, הזינו גם את מספר הטלפון.';

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
  protected readonly numberMax = ORDER_NUMBER_MAX_LENGTH;
  protected readonly phoneMax = PHONE_INPUT_MAX_LENGTH;
  /** Signed in, but the order was placed as a guest: look it up by number + phone like a signed-out customer. */
  protected readonly guest = signal(false);
  /** The phone is asked for: signed out, or a signed-in customer looking for a guest order. */
  protected readonly askPhone = computed(() => this.store.me() === null || this.guest());
  private prefilled = false;

  constructor() {
    effect(() => {
      const initial = this.initialNumber();
      untracked(() => {
        if (initial && !this.number()) this.number.set(initial.trim().slice(0, ORDER_NUMBER_MAX_LENGTH));
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
    // The lookup message stays until the next submit: removing it here would move the "המשך" button under the
    // pointer, and the first click after editing would miss it.
    if (this.errors()[field]) this.errors.update((e) => ({ ...e, [field]: undefined }));
  }

  protected submit(event: Event): void {
    event.preventDefault();
    void this.load(true);
  }

  /** "הזמנה שביצעתי כאורח?": shows the phone field and switches to the lookup by number + phone. */
  protected asGuest(): void {
    this.guest.set(true);
    this.formError.set('');
    this.focusLater('phone');
  }

  private focusLater(field: StepField | 'summary'): void {
    const id = field === 'summary' ? `${this.idPrefix()}-summary` : this.id(field);
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${id}`)?.focus(), {
      injector: this.injector,
    });
  }

  protected change(): void {
    this.current.set(null);
    this.orderChange.emit(null);
    this.focusLater('number');
  }

  /** `byCustomer`: the customer pressed the button (focus then moves to the found order); not the automatic load. */
  private async load(byCustomer = false): Promise<void> {
    if (this.busy()) return;
    const withPhone = this.askPhone();
    const number = this.number().trim();
    const phone = this.phone().trim();
    const errors: Partial<Record<StepField, string>> = {};
    if (!number) errors.number = REQUIRED.number;
    if (withPhone && !phone) errors.phone = REQUIRED.phone;
    this.errors.set(errors);
    const first = (['number', 'phone'] as const).find((f) => errors[f]);
    if (first) {
      this.formError.set('');
      this.focusLater(first);
      return;
    }
    this.busy.set(true);
    try {
      const result = await this.api.loadOrder(number, withPhone ? phone : null);
      this.formError.set('');
      this.current.set(result);
      this.orderChange.emit(result);
      if (byCustomer) this.focusLater('summary');
    } catch (error) {
      if (!withPhone && this.store.unauthorized(error)) return;
      const failure = supportFailure(error);
      if (failure.status === 404 && !withPhone) {
        // The account has no such order: it may be a guest order, which needs its phone.
        this.guest.set(true);
        this.formError.set(GUEST_ORDER_HINT_HE);
        this.focusLater('phone');
        return;
      }
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
