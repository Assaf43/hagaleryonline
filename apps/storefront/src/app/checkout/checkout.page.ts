import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  Injector,
  PLATFORM_ID,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { DiscountAmount } from '../core/discount-amount';
import { isPlatformBrowser } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { Subject, catchError, debounceTime, map, of, startWith, switchMap } from 'rxjs';
import type { CheckoutPrefill, CustomerAddressView, LocalityOption, ShippingMethod, ShippingQuote } from '@hg/models';
import { CustomerStore } from '../account/customer.store';
import { CartStore } from '../core/cart.store';
import { deliveryEstimateText, formatPrice } from '../core/format';
import { PageMeta } from '../core/page-meta';
import {
  CheckoutApi,
  ExternalNavigation,
  SHIPPING_METHOD_LABELS_HE,
  apiErrorCode,
  checkoutErrorMessage,
} from './checkout.api';
import {
  FIELD_IDS,
  MARKETING_ID,
  type CheckoutField,
  type CheckoutForm,
  type FieldErrors,
  firstError,
  isCheckoutField,
  parseFloor,
  toCheckoutRequest,
  validateCheckout,
} from './checkout-form';
import { LocalityField } from './locality-field';

/** Quotes wait this long after the last change of locality, floor or elevator. */
const QUOTE_DEBOUNCE_MS = 300;

type QuoteState =
  { kind: 'none' } | { kind: 'loading' } | { kind: 'ready'; quote: ShippingQuote } | { kind: 'error'; message: string };

const EMPTY_FORM: CheckoutForm = {
  fullName: '',
  phone: '',
  email: '',
  locality: null,
  street: '',
  houseNumber: '',
  apartment: '',
  floor: '',
  hasElevator: false,
  notes: '',
  method: null,
  acceptTerms: false,
  marketingConsent: false,
};

/** The address part of the form, as "another address" leaves it. */
const EMPTY_ADDRESS = {
  locality: null,
  street: '',
  houseNumber: '',
  apartment: '',
  floor: '',
  hasElevator: false,
  notes: '',
} satisfies Partial<CheckoutForm>;

/** The radio value of "another address" (saved addresses use their id). */
export const OTHER_ADDRESS = 'other';

/** The banner without a welcome benefit. */
const SIGN_IN_PLAIN = 'התחברו או הירשמו לחשבון';

/** Who checks out: known only in the browser, after the session read (`unknown` on the server). */
type Shopper = 'unknown' | 'guest' | 'customer';

/**
 * Checkout `/checkout` (spec §5.1, CHK-01–03): details, address and delivery, shipping method (both methods with
 * their quote, refreshed 300 ms after the locality, floor or elevator change) and summary with the terms. The
 * cart belongs to a cookie, so the server renders only the heading; the form appears once the cart has loaded,
 * and an empty (or fully unavailable) cart goes back to /cart. Submitting opens the payment provider's page.
 *
 * The session (spec §6.4) is read in the browser after hydration, never on the server: a guest sees a banner inviting
 * to sign in (with the active welcome benefit) or to continue as a guest, and the marketing checkbox (unchecked); a
 * signed-in customer gets the contact and the default address filled in and can pick another saved address.
 */
@Component({
  selector: 'hg-checkout-page',
  imports: [DiscountAmount, RouterLink, LocalityField],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './checkout.page.html',
  styleUrl: './checkout.page.scss',
})
export class CheckoutPage {
  protected readonly cart = inject(CartStore);
  private readonly customer = inject(CustomerStore);
  private readonly browser = isPlatformBrowser(inject(PLATFORM_ID));
  private readonly api = inject(CheckoutApi);
  private readonly router = inject(Router);
  private readonly external = inject(ExternalNavigation);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);
  private readonly requote$ = new Subject<void>();

  protected readonly form = signal<CheckoutForm>(EMPTY_FORM);
  protected readonly errors = signal<FieldErrors>({});
  protected readonly quote = signal<QuoteState>({ kind: 'none' });
  protected readonly submitting = signal(false);
  /** A new quote is on its way while the previous one stays on screen (no flicker of the method cards). */
  protected readonly refreshing = signal(false);
  /** A message about the whole order (not one field); `cartLink` adds "לסל הקניות". */
  protected readonly formError = signal<{ message: string; cartLink: boolean } | null>(null);

  protected readonly shopper = signal<Shopper>('unknown');
  /** The banner's text, once the welcome benefit was read (empty until then). */
  protected readonly bannerText = signal('');
  protected readonly bannerClosed = signal(false);
  protected readonly savedAddresses = signal<CustomerAddressView[]>([]);
  /** The saved address in the form (its id), or `OTHER_ADDRESS`. */
  protected readonly addressChoice = signal(OTHER_ADDRESS);
  protected readonly otherAddress = OTHER_ADDRESS;

  protected readonly ids = FIELD_IDS;
  protected readonly marketingId = MARKETING_ID;
  protected readonly methodLabels = SHIPPING_METHOD_LABELS_HE;
  protected readonly price = formatPrice;

  protected readonly loading = computed(() => this.cart.view() === null && !this.cart.loadFailed());
  protected readonly failed = computed(() => this.cart.view() === null && this.cart.loadFailed());
  protected readonly lines = computed(() => (this.cart.view()?.lines ?? []).filter((l) => l.available));
  protected readonly options = computed(() => {
    const q = this.quote();
    return q.kind === 'ready' ? q.quote.methods : [];
  });
  protected readonly quoteMessage = computed(() => {
    const q = this.quote();
    return q.kind === 'error' ? q.message : '';
  });
  protected readonly chosen = computed(() => this.options().find((o) => o.method === this.form().method) ?? null);
  protected readonly discount = computed(() => this.cart.view()?.discount?.amount ?? 0);
  /** Why the entered coupon gives no discount (spec §6); kept by the cart store until the next write. */
  protected readonly couponNotices = computed(() =>
    this.noticesReady() ? (this.cart.view()?.notices ?? []).filter((n) => n.kind === 'coupon') : [],
  );
  /** Set one render after the summary appears, so its live region is in the page before the first notice. */
  private readonly noticesReady = signal(false);
  protected readonly total = computed(() => {
    const view = this.cart.view();
    return view ? view.subtotal - this.discount() + (this.chosen()?.total ?? 0) : 0;
  });
  protected readonly estimate = computed(() => {
    const e = this.cart.view()?.deliveryEstimate;
    return e ? deliveryEstimateText(e.leadTimeDays) : '';
  });

  constructor() {
    inject(PageMeta).set({
      title: 'מעבר לתשלום',
      description: 'פרטי המשלוח והתשלום של ההזמנה',
      path: '/checkout',
      noindex: true,
    });
    afterNextRender(() => {
      void this.cart.load();
      void this.readSession();
    });

    effect(() => {
      if (this.cart.view() && !untracked(this.noticesReady))
        afterNextRender(() => setTimeout(() => this.noticesReady.set(true)), { injector: this.injector });
    });

    // Nothing to order: back to the cart.
    effect(() => {
      const view = this.cart.view();
      if (view && view.itemCount === 0 && !this.submitting()) this.toCart();
    });

    // Every cart (re)load can change the prices: requote, so the method cards and the total are never stale.
    effect(() => {
      this.cart.view();
      untracked(() => this.requote$.next());
    });

    if (this.browser) {
      this.requote$
        .pipe(
          debounceTime(QUOTE_DEBOUNCE_MS),
          map(() => {
            const f = this.form();
            const floor = parseFloor(f.floor);
            return f.locality && floor !== null
              ? { localityId: f.locality.id, floor, hasElevator: f.hasElevator }
              : null;
          }),
          switchMap((req) =>
            req === null
              ? of<QuoteState>({ kind: 'none' })
              : this.api.quote(req).pipe(
                  map((quote): QuoteState => ({ kind: 'ready', quote })),
                  catchError((error: unknown) => of(this.quoteError(error))),
                  startWith<QuoteState>({ kind: 'loading' }),
                ),
          ),
          takeUntilDestroyed(inject(DestroyRef)),
        )
        .subscribe((state) => {
          // Keep the cards (and the focus on a radio) while the next quote loads; submit waits for it.
          if (state.kind === 'loading' && this.quote().kind === 'ready') {
            this.refreshing.set(true);
            return;
          }
          this.refreshing.set(false);
          this.quote.set(state);
        });
    }
  }

  /** Guest or customer: the banner (with the welcome benefit) or the prefill. Browser only (afterNextRender). */
  private async readSession(): Promise<void> {
    if (!this.browser) return;
    await this.customer.load();
    if (this.customer.me()) {
      let prefill: CheckoutPrefill | null = null;
      try {
        prefill = await this.api.prefill();
      } catch {
        // The form stays empty: the customer types the details as a guest would.
        this.shopper.set('customer');
        return;
      }
      if (prefill) {
        this.shopper.set('customer');
        this.applyPrefill(prefill);
        return;
      }
      // 204: the session ended meanwhile.
    }
    this.shopper.set('guest');
    let label: string | null = null;
    try {
      label = (await this.api.welcome())?.labelHe ?? null;
    } catch {
      // The plain invitation.
    }
    this.bannerText.set(label ? `התחברו או הירשמו וקבלו ${label}` : SIGN_IN_PLAIN);
  }

  /** The account's contact (fields the customer already typed stay) and its default address. */
  private applyPrefill({ contact, addresses }: CheckoutPrefill): void {
    this.form.update((f) => ({
      ...f,
      fullName: f.fullName || contact.fullName,
      phone: f.phone || contact.phone,
      email: f.email || contact.email,
    }));
    this.savedAddresses.set(addresses);
    const first = addresses.find((a) => a.isDefault) ?? addresses[0];
    const f = this.form();
    const untouched = !f.locality && !f.street && !f.houseNumber && !f.apartment && !f.floor && !f.notes;
    if (first && untouched) this.pickAddress(first.id);
  }

  /** A saved address fills the address fields; "another address" empties them. Either way the quote follows. */
  protected pickAddress(id: string): void {
    const a = this.savedAddresses().find((x) => x.id === id);
    this.addressChoice.set(a ? a.id : OTHER_ADDRESS);
    this.form.update((f) => ({
      ...f,
      ...(a
        ? {
            locality: { id: a.localityId, nameHe: a.localityNameHe },
            street: a.street,
            houseNumber: a.houseNumber,
            apartment: a.apartment ?? '',
            floor: String(a.floor),
            hasElevator: a.hasElevator,
            notes: a.notes ?? '',
          }
        : EMPTY_ADDRESS),
    }));
    this.errors.update((e) => Object.fromEntries(Object.entries(e).filter(([k]) => !k.startsWith('address.'))));
    this.requote$.next();
  }

  /** The address was changed by hand: it is no longer the saved one. */
  private addressEdited(): void {
    this.addressChoice.set(OTHER_ADDRESS);
  }

  /** "המשך כאורח": the banner goes and the focus moves to the first field (or the heading while the cart loads). */
  protected continueAsGuest(): void {
    this.bannerClosed.set(true);
    afterNextRender(
      () => {
        const root = this.host.nativeElement;
        (
          root.querySelector<HTMLElement>(`#${FIELD_IDS['contact.fullName']}`) ?? root.querySelector<HTMLElement>('h1')
        )?.focus();
      },
      { injector: this.injector },
    );
  }

  protected setMarketing(event: Event) {
    const marketingConsent = (event.target as HTMLInputElement).checked;
    this.form.update((f) => ({ ...f, marketingConsent }));
  }

  protected retryLoad(): void {
    void this.cart.load();
  }

  protected retryQuote(): void {
    this.requote$.next();
  }

  /** Text fields. */
  protected set(
    field: 'fullName' | 'phone' | 'email' | 'street' | 'houseNumber' | 'apartment' | 'notes',
    event: Event,
  ) {
    const value = (event.target as HTMLInputElement | HTMLTextAreaElement).value;
    this.form.update((f) => ({ ...f, [field]: value }));
    const contact = field === 'fullName' || field === 'phone' || field === 'email';
    if (!contact) this.addressEdited();
    this.clearError(`${contact ? 'contact' : 'address'}.${field}` as CheckoutField);
  }

  protected setLocality(locality: LocalityOption | null) {
    this.form.update((f) => ({ ...f, locality }));
    this.addressEdited();
    if (locality) this.clearError('address.localityId');
    this.requote$.next();
  }

  protected setFloor(event: Event) {
    const floor = (event.target as HTMLInputElement).value;
    this.form.update((f) => ({ ...f, floor }));
    this.addressEdited();
    this.clearError('address.floor');
    this.requote$.next();
  }

  protected setElevator(event: Event) {
    const hasElevator = (event.target as HTMLInputElement).checked;
    this.form.update((f) => ({ ...f, hasElevator }));
    this.addressEdited();
    this.clearError('address.hasElevator');
    this.requote$.next();
  }

  protected setMethod(method: ShippingMethod) {
    this.form.update((f) => ({ ...f, method }));
    this.clearError('method');
  }

  protected setTerms(event: Event) {
    const acceptTerms = (event.target as HTMLInputElement).checked;
    this.form.update((f) => ({ ...f, acceptTerms }));
    this.clearError('acceptTerms');
  }

  protected errorOf(field: CheckoutField): string {
    return this.errors()[field] ?? '';
  }

  protected async submit(event: Event): Promise<void> {
    event.preventDefault();
    if (this.submitting()) return;
    this.formError.set(null);
    const form = this.form();
    const errors = validateCheckout(form);
    this.errors.set(errors);
    const first = firstError(errors);
    if (first) {
      this.focusField(first);
      return;
    }
    if (this.refreshing()) {
      this.formError.set({ message: 'מחשבים מחדש את מחיר המשלוח. נסו שוב בעוד רגע.', cartLink: false });
      return;
    }
    // A method may still be picked while its price is gone (the requote failed): never order without it on screen.
    if (!this.chosen()) {
      this.formError.set({
        message: 'מחיר המשלוח עדיין לא חושב. בדקו את הכתובת, בחרו שיטת משלוח ונסו שוב.',
        cartLink: false,
      });
      this.focusField('method');
      return;
    }
    this.submitting.set(true);
    try {
      // The total on screen goes along: if it is no longer the price, the server refuses (price_changed).
      const { redirectUrl } = await this.api.checkout(toCheckoutRequest(form, this.total()));
      // The page is leaving: the button stays disabled.
      this.external.assign(redirectUrl);
    } catch (error) {
      this.submitting.set(false);
      this.checkoutFailed(error);
    }
  }

  private checkoutFailed(error: unknown): void {
    const code = apiErrorCode(error);
    if (code === 'invalid_field' && error instanceof HttpErrorResponse) {
      const body = error.error as { field?: unknown; messageHe?: unknown };
      if (isCheckoutField(body.field) && typeof body.messageHe === 'string') {
        this.errors.set({ [body.field]: body.messageHe });
        this.focusField(body.field);
        return;
      }
    }
    if (code === 'empty_cart') {
      this.toCart();
      return;
    }
    if (code === 'coupon_invalid') {
      // The coupon was used up meanwhile: the reloaded cart no longer has it (its notice says so) and shows the
      // total without it.
      const body = error instanceof HttpErrorResponse ? (error.error as { messageHe?: unknown }) : {};
      this.formError.set({
        message: typeof body.messageHe === 'string' ? body.messageHe : checkoutErrorMessage(code),
        cartLink: false,
      });
      void this.cart.load();
      return;
    }
    if (code === 'price_changed') {
      const total = error instanceof HttpErrorResponse ? (error.error as { total?: unknown }).total : undefined;
      this.formError.set({
        message:
          typeof total === 'number'
            ? `המחיר השתנה מאז שהצגנו אותו. הסכום החדש לתשלום: ${formatPrice(total)}. בדקו את הסיכום ולחצו שוב על ״למעבר לתשלום״.`
            : checkoutErrorMessage(code),
        cartLink: false,
      });
      void this.cart.load();
      return;
    }
    this.formError.set({ message: checkoutErrorMessage(code), cartLink: code === 'insufficient_stock' });
    // The reload requotes too (the effect on the cart view).
    if (code === 'insufficient_stock' || code === 'cart_changed') void this.cart.load();
  }

  private quoteError(error: unknown): QuoteState {
    const code = apiErrorCode(error);
    if (code === 'empty_cart') this.toCart();
    if (code === 'shipping_unavailable' || code === 'unknown_locality')
      return { kind: 'error', message: checkoutErrorMessage(code) };
    return { kind: 'error', message: 'לא הצלחנו לחשב את מחיר המשלוח.' };
  }

  private toCart(): void {
    void this.router.navigateByUrl('/cart', { replaceUrl: true });
  }

  private clearError(field: CheckoutField): void {
    if (!this.errors()[field]) return;
    this.errors.update((e) => {
      const next = { ...e };
      delete next[field];
      return next;
    });
  }

  /** After the errors render (so the control's aria-describedby already points at its message). */
  private focusField(field: CheckoutField): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(`#${FIELD_IDS[field]}`)?.focus(), {
      injector: this.injector,
    });
  }
}
