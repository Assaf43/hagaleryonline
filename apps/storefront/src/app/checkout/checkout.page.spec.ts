import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router, provideRouter } from '@angular/router';
import type { CartView, ShippingQuote } from '@hg/models';
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

  async function setup(view: CartView = cartView([cartLine(1, 2, 150000)])) {
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

  /** Fills a valid form up to the quote, flushes the quote and picks full service. */
  async function fillValid() {
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
    q('input[name="method"][value="full_service"]').click();
    q('#chk-acceptTerms').click();
    fixture.detectChanges();
  }

  afterEach(() => {
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
    expect(terms.textContent?.replace(/\s+/g, ' ').trim()).toBe('קראתי ואני מסכים/ה לתנאי השימוש');
    expect(el().querySelector('a[href="/terms"]')?.textContent?.trim()).toBe('תנאי השימוש');
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
    });
    expect(q<HTMLButtonElement>('button[type="submit"]').disabled).toBe(true);
    req.flush({ redirectUrl: 'http://localhost:4200/pay/sandbox/abc' }, { status: 201, statusText: 'Created' });
    await render();
    expect(assign).toHaveBeenCalledWith('http://localhost:4200/pay/sandbox/abc');
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
});
