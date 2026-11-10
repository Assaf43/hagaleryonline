import { Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import type { FulfillmentMode } from '@hg/models';
import { CartStore } from '../core/cart.store';
import { cartLine, cartView } from '../core/cart.testing';
import { AddToCart } from './add-to-cart';

@Component({
  imports: [AddToCart],
  template: `<hg-add-to-cart [variantId]="variantId()" [fulfillment]="fulfillment()" [maxQuantity]="max()" />`,
})
class Host {
  readonly variantId = signal<number | null>(7);
  readonly fulfillment = signal<FulfillmentMode>('in_stock');
  readonly max = signal(3);
}

/** Lets the awaited cart call finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve));

describe('AddToCart', () => {
  function setup() {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const fixture = TestBed.createComponent(Host);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return {
      fixture,
      el,
      host: fixture.componentInstance,
      http: TestBed.inject(HttpTestingController),
      store: TestBed.inject(CartStore),
      main: () => el.querySelector<HTMLButtonElement>('button.add')!,
      plus: () => el.querySelector<HTMLButtonElement>('button[aria-label="הגדלת הכמות"]')!,
      minus: () => el.querySelector<HTMLButtonElement>('button[aria-label="הקטנת הכמות"]')!,
      qty: () => el.querySelector('.qty')?.textContent?.trim(),
      status: () => el.querySelector('[role="status"]')?.textContent?.trim(),
    };
  }

  it('shows the primary button "הוספה לסל"', () => {
    const { main } = setup();
    expect(main().textContent?.trim()).toBe('הוספה לסל');
    expect(main().classList).toContain('btn-primary');
    expect(main().disabled).toBe(false);
  });

  it('is disabled with "אזל מהמלאי" when out of stock or without a variant', () => {
    const { fixture, host, main, el } = setup();
    host.fulfillment.set('out_of_stock');
    fixture.detectChanges();
    expect(main().textContent?.trim()).toBe('אזל מהמלאי');
    expect(main().disabled).toBe(true);
    expect(el.querySelector('.stepper')).toBeNull();

    host.fulfillment.set('in_stock');
    host.variantId.set(null);
    fixture.detectChanges();
    expect(main().textContent?.trim()).toBe('אזל מהמלאי');
    expect(main().disabled).toBe(true);
  });

  it('the stepper stays between 1 and maxQuantity', () => {
    const { fixture, host, plus, minus, qty } = setup();
    expect(qty()).toBe('1');
    expect(minus().getAttribute('aria-disabled')).toBe('true');
    minus().click();
    fixture.detectChanges();
    expect(qty()).toBe('1');
    plus().click();
    plus().click();
    fixture.detectChanges();
    expect(qty()).toBe('3');
    expect(plus().getAttribute('aria-disabled')).toBe('true');
    plus().click();
    fixture.detectChanges();
    expect(qty()).toBe('3');
    minus().click();
    fixture.detectChanges();
    expect(qty()).toBe('2');

    // A smaller limit (another variant) brings the quantity down.
    host.max.set(1);
    fixture.detectChanges();
    expect(qty()).toBe('1');
    expect(plus().getAttribute('aria-disabled')).toBe('true');
  });

  it('a stepper button keeps keyboard focus at its bound', () => {
    const { fixture, el, plus, qty } = setup();
    document.body.appendChild(el);
    plus().focus();
    for (let i = 0; i < 4; i++) {
      plus().click();
      fixture.detectChanges();
    }
    expect(qty()).toBe('3');
    expect(plus().disabled).toBe(false);
    expect(document.activeElement).toBe(plus());
    el.remove();
  });

  it('adds the chosen quantity and opens the mini cart', async () => {
    const { fixture, el, http, store, main, plus, status } = setup();
    // Always rendered, so screen readers pick up the first message too.
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    plus().click();
    fixture.detectChanges();
    main().click();
    fixture.detectChanges();
    expect(main().getAttribute('aria-busy')).toBe('true');
    const req = http.expectOne({ method: 'POST', url: '/api/cart/items' });
    expect(req.request.body).toEqual({ variantId: 7, quantity: 2 });
    req.flush(cartView([cartLine(7, 2)]));
    await settle();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(store.count()).toBe(2);
    expect(store.miniCartOpen()).toBe(true);
    expect(main().getAttribute('aria-busy')).toBeNull();
    expect(status()).toBe('נוסף לסל');

    // Each success is announced again: the status is cleared while the next add runs.
    main().click();
    fixture.detectChanges();
    expect(status()).toBe('');
    http.expectOne('/api/cart/items').flush(cartView([cartLine(7, 4)]));
    await settle();
    fixture.detectChanges();
    expect(status()).toBe('נוסף לסל');
  });

  it('shows an inline error when adding fails', async () => {
    const { fixture, http, store, main, el } = setup();
    main().click();
    http.expectOne('/api/cart/items').flush({}, { status: 500, statusText: 'Server Error' });
    await settle();
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim()).toBe('לא הצלחנו להוסיף לסל. נסו שוב.');
    expect(store.miniCartOpen()).toBe(false);

    // The next try clears the message.
    main().click();
    fixture.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent?.trim() ?? '').toBe('');
    http.expectOne('/api/cart/items').flush(cartView([cartLine(7, 1)]));
    await settle();
  });
});
