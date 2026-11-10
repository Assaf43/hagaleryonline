import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { CartStore } from '../core/cart.store';
import { cartLine, cartView } from '../core/cart.testing';
import { PageMeta } from '../core/page-meta';
import { CartPage } from './cart.page';

const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('CartPage', () => {
  let fixture: ComponentFixture<CartPage>;
  let http: HttpTestingController;
  let store: CartStore;
  let metaSet: ReturnType<typeof vi.spyOn>;
  const el = () => fixture.nativeElement as HTMLElement;
  const text = () => el().textContent ?? '';

  async function setup(view: ReturnType<typeof cartView> | 'fail' | null = cartView([cartLine(1, 2, 150000)])) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    http = TestBed.inject(HttpTestingController);
    store = TestBed.inject(CartStore);
    metaSet = vi.spyOn(TestBed.inject(PageMeta), 'set');
    fixture = TestBed.createComponent(CartPage);
    fixture.detectChanges();
    if (view !== null) {
      const req = http.expectOne('/api/cart');
      if (view === 'fail') req.flush({}, { status: 500, statusText: 'Server Error' });
      else req.flush(view);
    }
    await fixture.whenStable();
    await settle();
    fixture.detectChanges();
  }

  it('sets a noindex title', async () => {
    await setup();
    expect(metaSet).toHaveBeenCalledWith({
      title: 'סל הקניות',
      description: 'המוצרים בסל שלכם',
      path: '/cart',
      noindex: true,
    });
  });

  it('shows "טוען…" until the cart arrives', async () => {
    await setup(null);
    expect(text()).toContain('טוען…');
  });

  it('shows a retry when the load fails', async () => {
    await setup('fail');
    expect(text()).toContain('לא הצלחנו לטעון את הסל.');
    el().querySelector<HTMLButtonElement>('button.retry')!.click();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1)]));
    await settle();
    fixture.detectChanges();
    expect(text()).not.toContain('לא הצלחנו לטעון את הסל.');
    expect(el().querySelectorAll('li.line').length).toBe(1);
  });

  it('renders lines, delivery estimate and subtotal', async () => {
    const view = cartView([cartLine(1, 2, 150000), cartLine(2, 1, 99000)]);
    view.lines[1].compareAtPrice = 120000;
    await setup(view);
    expect(el().querySelectorAll('li.line').length).toBe(2);
    expect(text()).toContain('MODEL1');
    expect(text()).toContain('מוצר 1');
    expect(text()).toContain('בז׳ · 280 ס״מ');
    expect(text()).toContain('3,000 ₪');
    expect(el().querySelector('s')?.textContent).toContain('1,200 ₪');
    expect(text()).toContain('זמן אספקה משוער: עד 14 ימי עסקים');
    expect(el().querySelector('.subtotal')?.textContent).toContain('3,990 ₪');
    expect(el().querySelector('a.checkout')?.getAttribute('href')).toBe('/checkout');
  });

  it('changes the quantity through the store', async () => {
    await setup();
    const spy = vi.spyOn(store, 'setQuantity');
    el().querySelector<HTMLButtonElement>('button[aria-label="הגדלת הכמות"]')!.click();
    expect(spy).toHaveBeenCalledWith(1, 3);
    http.expectOne({ method: 'PATCH', url: '/api/cart/items/1' }).flush(cartView([cartLine(1, 3, 150000)]));
    await settle();
    fixture.detectChanges();
    expect(el().querySelector('.subtotal')?.textContent).toContain('4,500 ₪');
  });

  it('does not step past the line limit', async () => {
    const view = cartView([cartLine(1, 2)]);
    view.lines[0].maxQuantity = 2;
    await setup(view);
    const spy = vi.spyOn(store, 'setQuantity');
    el().querySelector<HTMLButtonElement>('button[aria-label="הגדלת הכמות"]')!.click();
    expect(spy).not.toHaveBeenCalled();
  });

  it('removes a line with "הסרה"', async () => {
    await setup(cartView([cartLine(1, 1), cartLine(2, 1)]));
    const spy = vi.spyOn(store, 'remove');
    el().querySelector<HTMLButtonElement>('button.remove')!.click();
    expect(spy).toHaveBeenCalledWith(1);
    http.expectOne({ method: 'DELETE', url: '/api/cart/items/1' }).flush(cartView([cartLine(2, 1)]));
    await settle();
    fixture.detectChanges();
    expect(el().querySelectorAll('li.line').length).toBe(1);
  });

  it('greys an unavailable line, keeps it out of the total and disables checkout when nothing is available', async () => {
    const view = cartView([cartLine(1, 1)]);
    view.lines[0].available = false;
    view.lines[0].unavailableReason = 'hidden';
    view.itemCount = 0;
    view.subtotal = 0;
    view.deliveryEstimate = null;
    await setup(view);
    const line = el().querySelector('li.line')!;
    expect(line.classList).toContain('unavailable');
    expect(line.querySelector('.unavailable-label')?.textContent?.trim()).toBe('לא זמין יותר');
    expect(line.querySelector('hg-quantity-stepper')).toBeNull();
    expect(line.querySelector('button.remove')).not.toBeNull();
    expect(text()).not.toContain('זמן אספקה משוער');
    const checkout = el().querySelector<HTMLElement>('.checkout')!;
    expect(checkout.getAttribute('aria-disabled')).toBe('true');
    expect(checkout.getAttribute('href')).toBeNull();
  });

  it('labels a sold-out line "אזל מהמלאי"', async () => {
    const view = cartView([cartLine(1, 1), { ...cartLine(2, 1), available: false, unavailableReason: 'sold_out' }]);
    await setup(view);
    const line = el().querySelectorAll('li.line')[1];
    expect(line.querySelector('.unavailable-label')?.textContent?.trim()).toBe('אזל מהמלאי');
  });

  it('gives each "הסרה" button the model name as its accessible name', async () => {
    await setup(cartView([cartLine(1, 1), cartLine(2, 1)]));
    const labels = Array.from(el().querySelectorAll('button.remove')).map((b) => b.getAttribute('aria-label'));
    expect(labels).toEqual(['הסרת MODEL1', 'הסרת MODEL2']);
  });

  it('the polite notices region is there before the cart arrives', async () => {
    await setup(null);
    expect(text()).toContain('טוען…');
    expect(el().querySelector('ul.notices')?.getAttribute('aria-live')).toBe('polite');
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1)]));
  });

  for (const status of [404, 409]) {
    it(`reloads the cart after a write fails with ${status}`, async () => {
      await setup(cartView([cartLine(1, 2), cartLine(2, 1)]));
      el().querySelector<HTMLButtonElement>('button[aria-label="הגדלת הכמות"]')!.click();
      http.expectOne({ method: 'PATCH', url: '/api/cart/items/1' }).flush({}, { status, statusText: 'Error' });
      await settle();
      fixture.detectChanges();
      expect(el().querySelector('.error')?.textContent).toContain('לא הצלחנו לעדכן את הסל. נסו שוב.');
      http
        .expectOne({ method: 'GET', url: '/api/cart' })
        .flush(cartView([{ ...cartLine(1, 2), available: false, unavailableReason: 'hidden' }, cartLine(2, 1)]));
      await settle();
      fixture.detectChanges();
      expect(el().querySelector('li.line')?.classList).toContain('unavailable');
    });
  }

  it('does not reload after a write fails for another reason', async () => {
    await setup();
    el().querySelector<HTMLButtonElement>('button[aria-label="הגדלת הכמות"]')!.click();
    http.expectOne('/api/cart/items/1').flush({}, { status: 500, statusText: 'Server Error' });
    await settle();
    http.expectNone('/api/cart');
  });

  it('announces notices politely', async () => {
    await setup(cartView([cartLine(1, 1)], [{ variantId: 1, kind: 'quantity_clamped', messageHe: 'הכמות עודכנה' }]));
    const list = el().querySelector('ul.notices')!;
    expect(list.getAttribute('aria-live')).toBe('polite');
    expect(list.textContent).toContain('הכמות עודכנה');
  });

  it('renders nothing for shipping and coupon rows until their fields are set', async () => {
    await setup();
    expect(el().querySelector('.shipping-row')).toBeNull();
    expect(el().querySelector('.discount-row')).toBeNull();
  });

  it('shows shipping and discount rows when present', async () => {
    const view = cartView([cartLine(1, 1)]);
    view.shippingFrom = 25000;
    view.discount = { labelHe: 'קופון', amount: 10000, source: 'coupon', code: 'X' };
    await setup(view);
    const shipping = el().querySelector('.shipping-row')?.textContent?.replace(/\s+/g, ' ').trim();
    expect(shipping).toBe('משלוח החל מ־250 ₪');
    expect(el().querySelector('.discount-row')?.textContent).toContain('100 ₪');
  });

  it('shows the empty state with a link to continue shopping', async () => {
    await setup(cartView());
    expect(text()).toContain('הסל ריק');
    const link = el().querySelector('a.btn')!;
    expect(link.textContent).toContain('להמשך קניות');
    expect(link.getAttribute('href')).toBe('/');
    expect(el().querySelector('.checkout')).toBeNull();
  });
});
