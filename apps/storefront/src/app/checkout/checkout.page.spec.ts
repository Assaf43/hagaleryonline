import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PLATFORM_ID } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import type {
  CartView,
  CheckoutPrefill,
  CustomerAddressView,
  CustomerMe,
  ShippingQuote,
  WelcomeBenefit,
} from '@hg/models';
import { customerMe } from '../account/account.testing';
import { CartStore } from '../core/cart.store';
import { cartLine, cartView } from '../core/cart.testing';
import { PageMeta } from '../core/page-meta';
import { ExternalNavigation } from './checkout.api';
import { CheckoutPage } from './checkout.page';

const QUOTE: ShippingQuote = {
  methods: [
    { method: 'curbside', total: 25000, lines: [{ labelHe: 'משלוח', amount: 25000 }] },
    {
      method: 'full_service',
      total: 55000,
      lines: [
        { labelHe: 'משלוח', amount: 25000 },
        { labelHe: 'הרכבה', amount: 20000 },
        { labelHe: 'תוספת קומה', amount: 10000 },
      ],
    },
  ],
};

describe('CheckoutPage', () => {
  let fixture: ComponentFixture<CheckoutPage>;
  let http: HttpTestingController;
  let assign: ReturnType<typeof vi.fn>;
  let navigateByUrl: ReturnType<typeof vi.spyOn>;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const q = <T extends HTMLElement = HTMLInputElement>(selector: string) => el().querySelector<T>(selector)!;
  const render = async () => {
    await vi.advanceTimersByTimeAsync(0);
    fixture.detectChanges();
  };
  const fill = (id: string, value: string) => {
    const input = q<HTMLInputElement | HTMLTextAreaElement>(`#${id}`);
    input.value = value;
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();
  };
  const submit = async () => {
    q<HTMLFormElement>('form').dispatchEvent(new Event('submit', { cancelable: true }));
    await render();
  };
  const quoteRequests = () => http.match((r) => r.url === '/api/shipping/quote');

  /** Who checks out: a guest (`me: null`, with or without a welcome benefit) or a customer with the prefill. */
  interface Session {
    me?: CustomerMe | null;
    welcome?: WelcomeBenefit | null;
    /** The welcome read fails (500). */
    welcomeFails?: boolean;
    prefill?: CheckoutPrefill | null;
  }

  async function setup(view: CartView = cartView([cartLine(1, 2, 150000)]), session: Session = {}) {
    vi.useFakeTimers();
    assign = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: ExternalNavigation, useValue: { assign } },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    navigateByUrl = vi.spyOn(TestBed.inject(Router), 'navigateByUrl').mockResolvedValue(true);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(CheckoutPage);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    http.expectOne('/api/cart').flush(view);
    // The session is read in the browser after the first render: the banner (guest) or the prefill (customer).
    const me = session.me ?? null;
    http.expectOne('/api/account/me').flush(me);
    await render();
    if (me) http.expectOne('/api/checkout/prefill').flush(session.prefill ?? null);
    else if (session.welcomeFails)
      http.expectOne('/api/promotions/welcome').flush('down', { status: 500, statusText: 'Server Error' });
    else http.expectOne('/api/promotions/welcome').flush(session.welcome ?? null);
    await render();
  }

  async function pickLocality() {
    const input = q('#chk-locality');
    input.value = 'תל';
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(200);
    http.expectOne((r) => r.url === '/api/localities').flush([{ id: 5000, nameHe: 'תל אביב - יפו' }]);
    fixture.detectChanges();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    fixture.detectChanges();
  }

  /** Fills a valid form up to the quote, flushes the quote and (unless told not to) picks full service. */
  async function fillValid(pickMethod = true) {
    fill('chk-fullName', 'דנה כהן');
    fill('chk-phone', '050-1234567');
    fill('chk-email', 'dana@example.com');
    await pickLocality();
    fill('chk-street', 'הרצל');
    fill('chk-houseNumber', '12');
    fill('chk-floor', '3');
    await vi.advanceTimersByTimeAsync(300);
    http.expectOne('/api/shipping/quote').flush(QUOTE);
    await render();
    if (pickMethod) q('input[name="method"][value="full_service"]').click();
    q('#chk-acceptTerms').click();
    fixture.detectChanges();
  }

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
    vi.useRealTimers();
  });

  it('sets a noindex title', async () => {
    await setup();
    expect(metaSet).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'מעבר לתשלום', path: '/checkout', noindex: true }),
    );
  });

  it('has the four sections and the terms checkbox with a link to /terms', async () => {
    await setup();
    const headings = Array.from(el().querySelectorAll('h2')).map((h) => h.textContent?.trim());
    expect(headings).toEqual(['פרטים', 'כתובת ומסירה', 'שיטת משלוח', 'סיכום']);
    const terms = q('label[for="chk-acceptTerms"]');
    expect(terms.textContent?.replace(/\s+/g, ' ').trim()).toBe('קראתי ואני מסכים/ה לתנאי השימוש (נפתח בחלון חדש)');
    const link = q<HTMLAnchorElement>('a[href="/terms"]');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.querySelector('.visually-hidden')?.textContent?.trim()).toBe('(נפתח בחלון חדש)');
    expect(q('button[type="submit"]').textContent?.trim()).toBe('למעבר לתשלום');
  });

  it('shows the cart lines and subtotal in the summary', async () => {
    await setup();
    const summary = q<HTMLElement>('.summary');
    expect(summary.textContent).toContain('MODEL1');
    expect(summary.textContent).toContain('3,000 ₪');
  });

  it('redirects an empty cart to /cart', async () => {
    await setup(cartView());
    expect(navigateByUrl).toHaveBeenCalledWith('/cart', { replaceUrl: true });
  });

  it('redirects a cart with only unavailable lines to /cart', async () => {
    const view = cartView([{ ...cartLine(1, 1), available: false, unavailableReason: 'sold_out' }]);
    view.itemCount = 0;
    await setup(view);
    expect(navigateByUrl).toHaveBeenCalledWith('/cart', { replaceUrl: true });
  });

  it('shows inline errors on submit, focuses the first one and sends nothing', async () => {
    await setup();
    fill('chk-email', 'dana@example.com');
    await submit();
    http.expectNone('/api/checkout');
    const name = q('#chk-fullName');
    expect(document.activeElement).toBe(name);
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(name.getAttribute('aria-describedby')).toBe('chk-fullName-error');
    expect(q<HTMLElement>('#chk-fullName-error').textContent).toContain('יש למלא שם מלא (2–80 תווים)');
    expect(q<HTMLElement>('#chk-phone-error').textContent).toContain('יש להזין מספר טלפון נייד תקין');
    expect(el().querySelector('#chk-email-error')).toBeNull();
    expect(q('#chk-email').getAttribute('aria-invalid')).toBeNull();
    expect(q<HTMLElement>('#chk-locality-error').textContent).toContain('יש לבחור יישוב מהרשימה');
    expect(q<HTMLElement>('#chk-acceptTerms-error').textContent).toContain('יש לאשר את תנאי השימוש');
  });

  it('clears a field error once the field changes', async () => {
    await setup();
    await submit();
    fill('chk-fullName', 'דנה כהן');
    expect(el().querySelector('#chk-fullName-error')).toBeNull();
  });

  it('refreshes the quote 300 ms after the last locality, floor or elevator change', async () => {
    await setup();
    await pickLocality();
    fill('chk-floor', '2');
    await vi.advanceTimersByTimeAsync(200);
    fill('chk-floor', '4');
    await vi.advanceTimersByTimeAsync(299);
    expect(quoteRequests().length).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    const [req] = quoteRequests();
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ localityId: 5000, floor: 4, hasElevator: false });
    req.flush(QUOTE);
    await render();

    q('#chk-hasElevator').click();
    fixture.detectChanges();
    await vi.advanceTimersByTimeAsync(300);
    expect(http.expectOne('/api/shipping/quote').request.body).toEqual({
      localityId: 5000,
      floor: 4,
      hasElevator: true,
    });
  });

  it('does not quote before a locality and a floor are set', async () => {
    await setup();
    fill('chk-floor', '2');
    await vi.advanceTimersByTimeAsync(400);
    expect(quoteRequests().length).toBe(0);
    expect(el().textContent).toContain('בחרו יישוב והזינו קומה כדי לראות את מחירי המשלוח');
  });

  it('shows both methods as radio cards with total and breakdown, and adds the chosen one to the total', async () => {
    await setup();
    await fillValid();
    const cards = Array.from(el().querySelectorAll<HTMLElement>('.method'));
    expect(cards.length).toBe(2);
    expect(cards[0].textContent).toContain('עד נקודת הפריקה');
    expect(cards[0].textContent).toContain('250 ₪');
    expect(cards[1].textContent).toContain('כולל סבלות והרכבה');
    expect(cards[1].textContent).toContain('550 ₪');
    expect(cards[1].textContent).toContain('תוספת קומה');
    expect(q<HTMLElement>('.summary .total').textContent).toContain('3,550 ₪');
  });

  it('shows the discount line and the coupon notice in the summary, and sends the total after the discount', async () => {
    const view = cartView(
      [cartLine(1, 2, 150000)],
      [{ variantId: null, kind: 'coupon', messageHe: 'המבצע הנוכחי משתלם יותר מהקופון' }],
    );
    view.discount = { labelHe: 'מבצע סוף עונה', amount: 30000, source: 'automatic', code: null };
    view.couponCode = 'SAVE10';
    await setup(view);
    await fillValid();
    const row = q<HTMLElement>('.summary .discount-row');
    expect(row.textContent?.replace(/\s+/g, ' ').trim()).toBe('מבצע סוף עונה: −300 ₪');
    expect(row.querySelector('bdi[dir="ltr"]')?.textContent).toBe('−300');
    expect(q<HTMLElement>('.summary .coupon-notice').textContent).toContain('המבצע הנוכחי משתלם יותר מהקופון');
    // 3,000 − 300 + full service 550.
    expect(q<HTMLElement>('.summary .total').textContent).toContain('3,250 ₪');
    await submit();
    const req = http.expectOne('/api/checkout');
    expect(req.request.body).toMatchObject({ expectedTotal: 325000 });
    req.flush({ redirectUrl: 'http://localhost:4200/pay/sandbox/abc' }, { status: 201, statusText: 'Created' });
    await render();
  });

  it('says when shipping is not available', async () => {
    await setup();
    await pickLocality();
    fill('chk-floor', '0');
    await vi.advanceTimersByTimeAsync(300);
    http
      .expectOne('/api/shipping/quote')
      .flush({ statusCode: 503, code: 'shipping_unavailable' }, { status: 503, statusText: 'Unavailable' });
    await render();
    expect(el().textContent).toContain('המשלוח אינו זמין כרגע');
  });

  it('submits the order and goes to the payment page', async () => {
    await setup();
    await fillValid();
    fill('chk-apartment', '5');
    fill('chk-notes', 'להתקשר לפני');
    await submit();
    const req = http.expectOne('/api/checkout');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({
      contact: { fullName: 'דנה כהן', phone: '050-1234567', email: 'dana@example.com' },
      address: {
        localityId: 5000,
        street: 'הרצל',
        houseNumber: '12',
        apartment: '5',
        floor: 3,
        hasElevator: false,
        notes: 'להתקשר לפני',
      },
      method: 'full_service',
      acceptTerms: true,
      // Never pre-checked (CLAUDE.md §4.4).
      marketingConsent: false,
      // 2 × 1,500 + full service 550, as shown in the summary.
      expectedTotal: 355000,
    });
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    req.flush({ redirectUrl: 'http://localhost:4200/pay/sandbox/abc' }, { status: 201, statusText: 'Created' });
    await render();
    expect(assign).toHaveBeenCalledWith('http://localhost:4200/pay/sandbox/abc');
  });

  it('never submits without a shipping price on screen (the requote failed after a method was chosen)', async () => {
    await setup();
    await fillValid();
    fill('chk-floor', '4');
    await vi.advanceTimersByTimeAsync(300);
    http.expectOne('/api/shipping/quote').flush(null, { status: 0, statusText: 'Network error' });
    await render();
    expect(q('.summary').textContent).toContain('לפי הכתובת ושיטת המשלוח');

    await submit();
    http.expectNone('/api/checkout');
    expect(q('.form-error').textContent).toContain('מחיר המשלוח עדיין לא חושב');
    expect(document.activeElement?.id).toBe('chk-method');
  });

  it('shows a server field error inline and focuses it', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush(
        { statusCode: 400, code: 'invalid_field', field: 'address.street', messageHe: 'יש למלא רחוב (עד 80 תווים)' },
        { status: 400, statusText: 'Bad Request' },
      );
    await render();
    expect(q<HTMLElement>('#chk-street-error').textContent).toContain('יש למלא רחוב (עד 80 תווים)');
    expect(document.activeElement).toBe(q('#chk-street'));
    expect(assign).not.toHaveBeenCalled();
  });

  it('on a stock shortage asks to update the cart, with a link to it', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush(
        { statusCode: 409, code: 'insufficient_stock', variantId: 1, available: 1 },
        { status: 409, statusText: 'Conflict' },
      );
    await render();
    const alert = q<HTMLElement>('.form-error');
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.textContent).toContain('חלק מהפריטים כבר לא זמינים בכמות שביקשתם. עדכנו את הסל.');
    expect(alert.querySelector('a')?.getAttribute('href')).toBe('/cart');
    // The cart reloads, and the quote follows it so the cards and the total are not stale.
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1, 150000)]));
    await render();
    await vi.advanceTimersByTimeAsync(300);
    const requote = http.expectOne('/api/shipping/quote');
    expect(requote.request.body).toEqual({ localityId: 5000, floor: 3, hasElevator: false });
    requote.flush(QUOTE);
    await render();
    expect(q<HTMLElement>('.summary .total').textContent).toContain('2,050 ₪');
  });

  it('on cart_changed reloads the cart and the quote and asks to check again', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush({ statusCode: 409, code: 'cart_changed' }, { status: 409, statusText: 'Conflict' });
    await render();
    expect(q<HTMLElement>('.form-error').textContent).toContain('הסל השתנה בזמן ההזמנה. בדקו את הסיכום ונסו שוב.');
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2, 150000), cartLine(2, 1, 50000)]));
    await render();
    await vi.advanceTimersByTimeAsync(300);
    http.expectOne('/api/shipping/quote').flush(QUOTE);
    await render();
    expect(q<HTMLElement>('.summary').textContent).toContain('MODEL2');
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
  });

  it('on coupon_invalid shows the coupon message and reloads the cart', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush(
        { statusCode: 409, code: 'coupon_invalid', field: 'coupon', messageHe: 'הקופון נוצל במלואו' },
        { status: 409, statusText: 'Conflict' },
      );
    await render();
    expect(q<HTMLElement>('.form-error').textContent).toContain('הקופון נוצל במלואו');
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2, 150000)]));
    await render();
  });

  it('on price_changed shows the new total, reloads the cart and sends nothing more', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush({ statusCode: 409, code: 'price_changed', total: 370000 }, { status: 409, statusText: 'Conflict' });
    await render();
    const error = q<HTMLElement>('.form-error').textContent ?? '';
    expect(error).toContain('המחיר השתנה');
    expect(error).toContain('3,700 ₪');
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2, 155000)]));
    await render();
    await vi.advanceTimersByTimeAsync(300);
    http.expectOne('/api/shipping/quote').flush(QUOTE);
    await render();
    expect(q<HTMLElement>('.summary .total').textContent).toContain('3,650 ₪');
  });

  it('keeps the method cards (and the focus on a radio) while the cart reloads and requotes', async () => {
    await setup();
    await fillValid();
    const radio = q<HTMLInputElement>('input[name="method"][value="full_service"]');
    radio.focus();
    expect(document.activeElement).toBe(radio);

    void TestBed.inject(CartStore).load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2, 150000)]));
    await render();
    await vi.advanceTimersByTimeAsync(300);
    fixture.detectChanges();
    // The new quote is on its way: the cards are still there, the same elements, still focused.
    expect(q('input[name="method"][value="full_service"]')).toBe(radio);
    expect(document.activeElement).toBe(radio);
    expect(el().textContent).toContain('מעדכנים את מחיר המשלוח');

    // Submitting now would send a stale total: it waits.
    await submit();
    expect(q<HTMLElement>('.form-error').textContent).toContain('מחשבים מחדש');
    http.expectNone('/api/checkout');

    http.expectOne('/api/shipping/quote').flush(QUOTE);
    await render();
    expect(q('input[name="method"][value="full_service"]')).toBe(radio);
    expect(document.activeElement).toBe(radio);
    expect(el().textContent).not.toContain('מעדכנים את מחיר המשלוח');
  });

  it('focuses the method group when only the method is missing, and marks the radios invalid', async () => {
    await setup();
    await fillValid(false);
    await submit();
    http.expectNone('/api/checkout');
    const group = q<HTMLFieldSetElement>('#chk-method');
    expect(document.activeElement).toBe(group);
    expect(group.getAttribute('aria-describedby')).toBe('chk-method-error');
    expect(q<HTMLElement>('#chk-method-error').textContent).toContain('יש לבחור שיטת משלוח');
    const radios = Array.from(el().querySelectorAll('input[name="method"]'));
    expect(radios.map((r) => r.getAttribute('aria-invalid'))).toEqual(['true', 'true']);
    q('input[name="method"][value="curbside"]').click();
    fixture.detectChanges();
    expect(el().querySelector('#chk-method-error')).toBeNull();
    expect(radios.map((r) => r.getAttribute('aria-invalid'))).toEqual([null, null]);
  });

  it('sends the customer to /cart when the quote finds the cart empty', async () => {
    await setup();
    await pickLocality();
    fill('chk-floor', '0');
    await vi.advanceTimersByTimeAsync(300);
    http
      .expectOne('/api/shipping/quote')
      .flush({ statusCode: 409, code: 'empty_cart' }, { status: 409, statusText: 'Conflict' });
    await render();
    expect(navigateByUrl).toHaveBeenCalledWith('/cart', { replaceUrl: true });
  });

  it('says which locality problem the quote found', async () => {
    await setup();
    await pickLocality();
    fill('chk-floor', '0');
    await vi.advanceTimersByTimeAsync(300);
    http
      .expectOne('/api/shipping/quote')
      .flush({ statusCode: 400, code: 'unknown_locality' }, { status: 400, statusText: 'Bad Request' });
    await render();
    expect(q<HTMLElement>('.methods').textContent).toContain('יש לבחור יישוב מהרשימה');
  });

  it('sends an emptied cart back to /cart', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush({ statusCode: 409, code: 'empty_cart' }, { status: 409, statusText: 'Conflict' });
    await render();
    expect(navigateByUrl).toHaveBeenCalledWith('/cart', { replaceUrl: true });
  });

  it('explains a payment provider failure', async () => {
    await setup();
    await fillValid();
    await submit();
    http
      .expectOne('/api/checkout')
      .flush({ statusCode: 502, code: 'payment_unavailable' }, { status: 502, statusText: 'Bad Gateway' });
    await render();
    expect(q<HTMLElement>('.form-error').textContent).toContain('לא הצלחנו לפתוח את עמוד התשלום');
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(false);
  });

  describe('signed out (spec §6.4)', () => {
    const banner = () => el().querySelector<HTMLElement>('.signin-banner');

    it('invites to sign in with the welcome benefit, linking to sign-in and back to checkout', async () => {
      await setup(undefined, { welcome: { labelHe: '10% הנחה על ההזמנה הראשונה' } });
      expect(banner()?.querySelector('p')?.textContent?.trim()).toBe(
        'התחברו או הירשמו וקבלו 10% הנחה על ההזמנה הראשונה',
      );
      const link = banner()!.querySelector<HTMLAnchorElement>('a')!;
      expect(link.textContent?.trim()).toBe('התחברות');
      expect(link.getAttribute('href')).toBe('/account?next=%2Fcheckout');
      const guest = banner()!.querySelector<HTMLButtonElement>('button')!;
      expect(guest.type).toBe('button');
      expect(guest.textContent?.trim()).toBe('המשך כאורח');
      // The banner is named by its text for screen readers.
      expect(banner()!.getAttribute('aria-labelledby')).toBe(banner()!.querySelector('p')!.id);
    });

    it('without a welcome benefit invites to an account', async () => {
      await setup();
      expect(banner()?.querySelector('p')?.textContent?.trim()).toBe('התחברו או הירשמו לחשבון');
    });

    it('a failed welcome read still shows the plain invitation', async () => {
      await setup(undefined, { welcomeFails: true });
      expect(banner()?.querySelector('p')?.textContent?.trim()).toBe('התחברו או הירשמו לחשבון');
    });

    it('"continue as a guest" closes the banner and moves to the first field; the guest form keeps every field', async () => {
      await setup();
      banner()!.querySelector<HTMLButtonElement>('button')!.click();
      await render();
      expect(banner()).toBeNull();
      expect(document.activeElement).toBe(q('#chk-fullName'));
      for (const id of [
        'chk-fullName',
        'chk-phone',
        'chk-email',
        'chk-locality',
        'chk-street',
        'chk-houseNumber',
        'chk-apartment',
        'chk-floor',
        'chk-hasElevator',
        'chk-notes',
      ])
        expect(el().querySelector(`#${id}`), id).not.toBeNull();
      // No saved addresses for a guest.
      expect(el().querySelector('.saved-addresses')).toBeNull();
    });

    it('has a marketing consent checkbox, unchecked, and sends it with the order', async () => {
      await setup();
      const consent = q('#chk-marketing');
      expect(consent.type).toBe('checkbox');
      expect(consent.checked).toBe(false);
      expect(q<HTMLLabelElement>('label[for="chk-marketing"]').textContent?.trim()).toBe(
        'אני מאשר/ת קבלת עדכונים ומבצעים במייל',
      );
      await fillValid();
      consent.click();
      fixture.detectChanges();
      await submit();
      const req = http.expectOne('/api/checkout');
      expect(req.request.body).toMatchObject({ marketingConsent: true });
      req.flush({ redirectUrl: 'http://localhost:4200/pay/sandbox/abc' }, { status: 201, statusText: 'Created' });
      await render();
    });
  });

  describe('signed in (spec §6.4)', () => {
    const address = (id: string, over: Partial<CustomerAddressView> = {}): CustomerAddressView => ({
      id,
      localityId: 5000,
      localityNameHe: 'תל אביב - יפו',
      street: 'הרצל',
      houseNumber: '12',
      apartment: '5',
      floor: 3,
      hasElevator: true,
      notes: 'קוד בכניסה 1234',
      isDefault: false,
      ...over,
    });
    const HOME = address('a1', { isDefault: true });
    const WORK = address('a2', {
      localityId: 3000,
      localityNameHe: 'ירושלים',
      street: 'יפו',
      houseNumber: '97',
      apartment: null,
      floor: 0,
      hasElevator: false,
      notes: null,
    });
    const prefill = (addresses = [HOME, WORK]): CheckoutPrefill => ({
      contact: { fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.com' },
      addresses,
    });
    const radios = () => [...el().querySelectorAll<HTMLInputElement>('.saved-addresses input[type="radio"]')];

    it('shows no banner and no consent box, fills the contact and the default address and quotes it', async () => {
      await setup(undefined, { me: customerMe(), prefill: prefill() });
      expect(el().querySelector('.signin-banner')).toBeNull();
      expect(el().querySelector('#chk-marketing')).toBeNull();
      http.expectNone('/api/promotions/welcome');
      expect(q('#chk-fullName').value).toBe('דנה כהן');
      expect(q('#chk-phone').value).toBe('0501234567');
      expect(q('#chk-email').value).toBe('dana@example.com');
      expect(q('#chk-locality').value).toBe('תל אביב - יפו');
      expect(q('#chk-street').value).toBe('הרצל');
      expect(q('#chk-houseNumber').value).toBe('12');
      expect(q('#chk-apartment').value).toBe('5');
      expect(q('#chk-floor').value).toBe('3');
      expect(q('#chk-hasElevator').checked).toBe(true);
      expect(q<HTMLTextAreaElement>('#chk-notes').value).toBe('קוד בכניסה 1234');
      await vi.advanceTimersByTimeAsync(300);
      expect(http.expectOne('/api/shipping/quote').request.body).toEqual({
        localityId: 5000,
        floor: 3,
        hasElevator: true,
      });
    });

    it('lists the saved addresses as a radio group (default checked) plus "another address"', async () => {
      await setup(undefined, { me: customerMe(), prefill: prefill() });
      await vi.advanceTimersByTimeAsync(300);
      http.expectOne('/api/shipping/quote').flush(QUOTE);
      await render();
      const group = q<HTMLFieldSetElement>('fieldset.saved-addresses');
      expect(group.querySelector('legend')?.textContent?.trim()).toBe('כתובת שמורה');
      expect(radios()).toHaveLength(3);
      expect(radios().map((r) => r.checked)).toEqual([true, false, false]);
      const labels = [...group.querySelectorAll('label')].map((l) => l.textContent?.replace(/\s+/g, ' ').trim());
      expect(labels[0]).toContain('הרצל 12, דירה 5, תל אביב - יפו');
      expect(labels[0]).toContain('ברירת מחדל');
      expect(labels[1]).toContain('יפו 97, ירושלים');
      expect(labels[2]).toBe('כתובת אחרת');
      // House numbers are isolated from the Hebrew around them.
      expect(group.querySelector('label bdi')?.textContent).toBe('12');
      // Each radio is labelled by its own label (clicking the text picks it).
      expect(radios().every((r) => r.closest('label') !== null && r.name === 'savedAddress')).toBe(true);
    });

    it('picking another saved address fills its fields and requotes; "another address" empties them', async () => {
      await setup(undefined, { me: customerMe(), prefill: prefill() });
      await vi.advanceTimersByTimeAsync(300);
      http.expectOne('/api/shipping/quote').flush(QUOTE);
      await render();

      radios()[1].click();
      await render();
      expect(q('#chk-locality').value).toBe('ירושלים');
      expect(q('#chk-street').value).toBe('יפו');
      expect(q('#chk-houseNumber').value).toBe('97');
      expect(q('#chk-apartment').value).toBe('');
      expect(q('#chk-floor').value).toBe('0');
      expect(q('#chk-hasElevator').checked).toBe(false);
      await vi.advanceTimersByTimeAsync(300);
      const requote = http.expectOne('/api/shipping/quote');
      expect(requote.request.body).toEqual({ localityId: 3000, floor: 0, hasElevator: false });
      requote.flush(QUOTE);
      await render();

      radios()[2].click();
      await render();
      expect(q('#chk-locality').value).toBe('');
      expect(q('#chk-street').value).toBe('');
      expect(q('#chk-floor').value).toBe('');
      // The contact stays.
      expect(q('#chk-fullName').value).toBe('דנה כהן');
      await vi.advanceTimersByTimeAsync(300);
      expect(quoteRequests()).toHaveLength(0);
    });

    it('editing an address field leaves the saved address ("another address" is checked)', async () => {
      await setup(undefined, { me: customerMe(), prefill: prefill() });
      await vi.advanceTimersByTimeAsync(300);
      http.expectOne('/api/shipping/quote').flush(QUOTE);
      await render();
      fill('chk-apartment', '7');
      expect(radios().map((r) => r.checked)).toEqual([false, false, true]);
      expect(q('#chk-street').value).toBe('הרצל');
    });

    it('submits the prefilled order with the account contact and no marketing consent', async () => {
      await setup(undefined, { me: customerMe(), prefill: prefill([HOME]) });
      await vi.advanceTimersByTimeAsync(300);
      http.expectOne('/api/shipping/quote').flush(QUOTE);
      await render();
      q('input[name="method"][value="curbside"]').click();
      q('#chk-acceptTerms').click();
      fixture.detectChanges();
      await submit();
      const req = http.expectOne('/api/checkout');
      expect(req.request.body).toMatchObject({
        contact: { fullName: 'דנה כהן', phone: '0501234567', email: 'dana@example.com' },
        address: { localityId: 5000, street: 'הרצל', houseNumber: '12', apartment: '5', floor: 3, hasElevator: true },
        method: 'curbside',
        marketingConsent: false,
      });
      req.flush({ redirectUrl: 'http://localhost:4200/pay/sandbox/abc' }, { status: 201, statusText: 'Created' });
      await render();
    });

    it('without saved addresses fills only the contact', async () => {
      await setup(undefined, { me: customerMe(), prefill: prefill([]) });
      expect(q('#chk-fullName').value).toBe('דנה כהן');
      expect(q('#chk-street').value).toBe('');
      expect(el().querySelector('.saved-addresses')).toBeNull();
    });

    it('a session that ended (prefill 204) is treated as a guest', async () => {
      vi.useFakeTimers();
      TestBed.configureTestingModule({
        providers: [
          provideHttpClient(),
          provideHttpClientTesting(),
          provideRouter([]),
          { provide: ExternalNavigation, useValue: { assign: vi.fn() } },
        ],
      });
      http = TestBed.inject(HttpTestingController);
      fixture = TestBed.createComponent(CheckoutPage);
      fixture.detectChanges();
      http.expectOne('/api/cart').flush(cartView([cartLine(1, 2, 150000)]));
      http.expectOne('/api/account/me').flush(customerMe());
      await render();
      http.expectOne('/api/checkout/prefill').flush(null, { status: 204, statusText: 'No Content' });
      await render();
      http.expectOne('/api/promotions/welcome').flush(null);
      await render();
      expect(el().querySelector('.signin-banner')).not.toBeNull();
      expect(q('#chk-fullName').value).toBe('');
    });
  });

  it('the server render reads no session and shows no banner', async () => {
    vi.useFakeTimers();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
        { provide: PLATFORM_ID, useValue: 'server' },
      ],
    });
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(CheckoutPage);
    fixture.detectChanges();
    await render();
    http.expectNone('/api/account/me');
    http.expectNone('/api/promotions/welcome');
    http.expectNone('/api/checkout/prefill');
    expect(el().querySelector('.signin-banner')).toBeNull();
    expect(el().querySelector('h1')?.textContent).toContain('מעבר לתשלום');
  });
});
