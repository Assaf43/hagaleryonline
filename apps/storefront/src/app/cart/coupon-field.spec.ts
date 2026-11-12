import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { CartView } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { cartLine, cartView } from '../core/cart.testing';
import { CouponField } from './coupon-field';

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('CouponField', () => {
  let fixture: ComponentFixture<CouponField>;
  let http: HttpTestingController;
  const el = () => fixture.nativeElement as HTMLElement;
  const input = () => el().querySelector<HTMLInputElement>('input')!;
  const render = async () => {
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  };

  async function setup(view: CartView = cartView([cartLine(1, 1)])) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
    const store = TestBed.inject(CartStore);
    const loading = store.load();
    http.expectOne('/api/cart').flush(view);
    await loading;
    fixture = TestBed.createComponent(CouponField);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
  }

  async function enter(code: string) {
    input().value = code;
    input().dispatchEvent(new Event('input'));
    el()
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { cancelable: true }));
    fixture.detectChanges();
  }

  afterEach(() => {
    http.verify();
    fixture.nativeElement.remove();
  });

  it('has a labelled field "קוד קופון" and the button "החלה"', async () => {
    await setup();
    const label = el().querySelector<HTMLLabelElement>(`label[for="${input().id}"]`);
    expect(label?.textContent?.trim()).toBe('קוד קופון');
    expect(el().querySelector('button[type="submit"]')?.textContent?.trim()).toBe('החלה');
  });

  it('applies a code, shows it as a chip with "הסרה" and announces it', async () => {
    await setup();
    await enter('save10');
    const req = http.expectOne({ method: 'POST', url: '/api/cart/coupon' });
    expect(req.request.body).toEqual({ code: 'save10' });
    req.flush({
      ...cartView([cartLine(1, 1)]),
      couponCode: 'SAVE10',
      discount: { labelHe: 'קופון חורף', amount: 10000, source: 'coupon', code: 'SAVE10' },
    });
    await render();
    const chip = el().querySelector('.coupon-chip')!;
    expect(chip.querySelector('bdi[dir="ltr"]')?.textContent).toBe('SAVE10');
    const remove = chip.querySelector<HTMLButtonElement>('button')!;
    expect(remove.textContent?.trim()).toBe('הסרה');
    expect(remove.getAttribute('aria-label')).toBe('הסרת הקופון SAVE10');
    expect(el().querySelector('[aria-live="polite"]')?.textContent).toContain('הקופון הוחל');
    expect(el().querySelector('form')).toBeNull();
    // Focus moves to the chip's "הסרה" (the form with the focused field is gone).
    expect(document.activeElement).toBe(remove);
  });

  it('shows the reason under the field when the code is refused, and focuses it', async () => {
    await setup();
    await enter('NOPE');
    http
      .expectOne('/api/cart/coupon')
      .flush(
        { statusCode: 400, code: 'invalid_coupon', field: 'coupon', messageHe: 'קוד הקופון לא קיים' },
        { status: 400, statusText: 'Bad Request' },
      );
    await render();
    const error = el().querySelector('.field-error')!;
    expect(error.textContent?.trim()).toBe('קוד הקופון לא קיים');
    expect(input().getAttribute('aria-invalid')).toBe('true');
    expect(input().getAttribute('aria-describedby')).toBe(error.id);
    expect(document.activeElement).toBe(input());
    // Also read out in the live region, not only as the field's description.
    expect(el().querySelector('[aria-live="polite"]')?.textContent).toContain('קוד הקופון לא קיים');
    // Typing again clears it.
    input().value = 'NOPE2';
    input().dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(el().querySelector('.field-error')).toBeNull();
    expect(input().hasAttribute('aria-invalid')).toBe(false);
  });

  it('shows the throttle message on 429', async () => {
    await setup();
    await enter('ANY');
    http
      .expectOne('/api/cart/coupon')
      .flush({ statusCode: 429, code: 'too_many_requests' }, { status: 429, statusText: 'Too Many Requests' });
    await render();
    expect(el().querySelector('.field-error')?.textContent?.trim()).toBe(
      'ביצעתם יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
    );
    expect(el().querySelector('[aria-live="polite"]')?.textContent).toContain(
      'ביצעתם יותר מדי ניסיונות. נסו שוב בעוד כמה דקות.',
    );
  });

  it('sends nothing for an empty code', async () => {
    await setup();
    await enter('   ');
    http.expectNone('/api/cart/coupon');
  });

  it('keeps the entered code with "הסרה" and the reason when the coupon does not apply now', async () => {
    const view: CartView = {
      ...cartView(
        [cartLine(1, 1)],
        [{ variantId: null, kind: 'coupon', messageHe: 'המבצע הנוכחי משתלם יותר מהקופון' }],
      ),
      couponCode: 'SAVE10',
      discount: { labelHe: 'מבצע סוף עונה', amount: 20000, source: 'automatic', code: null },
    };
    await setup(view);
    await render();
    expect(el().querySelector('.coupon-chip bdi')?.textContent).toBe('SAVE10');
    expect(el().querySelector('.coupon-notice')?.textContent).toContain('המבצע הנוכחי משתלם יותר מהקופון');

    el().querySelector<HTMLButtonElement>('.coupon-chip button')!.click();
    http.expectOne({ method: 'DELETE', url: '/api/cart/coupon' }).flush(cartView([cartLine(1, 1)]));
    await render();
    expect(el().querySelector('.coupon-chip')).toBeNull();
    expect(el().querySelector('form')).not.toBeNull();
    expect(el().querySelector('[aria-live="polite"]')?.textContent).toContain('הקופון הוסר');
    // Focus goes to the field that replaced the chip.
    expect(document.activeElement).toBe(input());
  });

  it('shows the notice of a coupon the server removed (expired) next to the field', async () => {
    await setup(cartView([cartLine(1, 1)], [{ variantId: null, kind: 'coupon', messageHe: 'תוקף הקופון פג' }]));
    await render();
    expect(el().querySelector('.coupon-chip')).toBeNull();
    expect(el().querySelector('.coupon-notice')?.textContent).toContain('תוקף הקופון פג');
  });

  it('renders the live region empty first and fills it after, so the first notice is announced', async () => {
    await setup(cartView([cartLine(1, 1)], [{ variantId: null, kind: 'coupon', messageHe: 'תוקף הקופון פג' }]));
    const region = el().querySelector('[aria-live="polite"]')!;
    expect(region.textContent?.trim()).toBe('');
    await render();
    // The same element (already in the page), now with the notice.
    expect(el().querySelector('[aria-live="polite"]')).toBe(region);
    expect(region.textContent).toContain('תוקף הקופון פג');
  });
});
