import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { CartStore } from '../core/cart.store';
import { cartLine, cartView } from '../core/cart.testing';
import { customerMe } from '../account/account.testing';
import { SiteHeader } from './site-header';

describe('SiteHeader cart button', () => {
  function setup(platform: 'browser' | 'server' = 'browser') {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: platform },
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SiteHeader);
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, http, cart: () => el.querySelector<HTMLButtonElement>('button.cart')! };
  }

  it('loads the cart after the first render and shows the count badge', async () => {
    const { fixture, http, cart } = setup();
    fixture.detectChanges();
    // Not yet hydrated: no count.
    expect(cart().getAttribute('aria-label')).toBe('סל הקניות (0)');
    expect(cart().querySelector('.count')).toBeNull();

    await fixture.whenStable();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2), cartLine(2, 1)]));
    await fixture.whenStable();
    fixture.detectChanges();
    expect(cart().getAttribute('aria-label')).toBe('סל הקניות (3)');
    expect(cart().querySelector('.count')?.textContent?.trim()).toBe('3');
  });

  it('shows no badge for an empty cart', async () => {
    const { fixture, http, cart } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/cart').flush(cartView());
    await fixture.whenStable();
    fixture.detectChanges();
    expect(cart().getAttribute('aria-label')).toBe('סל הקניות (0)');
    expect(cart().querySelector('.count')).toBeNull();
  });

  it('opens the mini cart', async () => {
    const { fixture, http, cart } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/cart').flush(cartView());
    cart().click();
    expect(TestBed.inject(CartStore).miniCartOpen()).toBe(true);
  });

  it('the server render never reads the cart', async () => {
    const { fixture, http, cart, el } = setup('server');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    http.expectNone('/api/cart');
    expect(cart().getAttribute('aria-label')).toBe('סל הקניות (0)');
    expect(el.querySelector('button.cart .count')).toBeNull();
  });
});

describe('SiteHeader account icon', () => {
  function setup(platform: 'browser' | 'server' = 'browser') {
    TestBed.configureTestingModule({
      providers: [
        { provide: PLATFORM_ID, useValue: platform },
        provideHttpClient(),
        provideHttpClientTesting(),
        provideRouter([]),
      ],
    });
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(SiteHeader);
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el, http, link: () => el.querySelector<HTMLAnchorElement>('a.account')! };
  }

  it('shows "התחברות" to a signed-out visitor, linking to /account', async () => {
    const { fixture, http, link } = setup();
    fixture.detectChanges();
    await fixture.whenStable();
    http.expectOne('/api/account/me').flush(null);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(link().getAttribute('aria-label')).toBe('התחברות');
    expect(link().getAttribute('href')).toBe('/account');
    expect(link().querySelector('svg')).not.toBeNull();
  });

  it('shows "החשבון שלי" only after hydration, once the session answers', async () => {
    const { fixture, http, link } = setup();
    fixture.detectChanges();
    // Before hydration the markup is the signed-out one, the same as the server render.
    expect(link().getAttribute('aria-label')).toBe('התחברות');
    await fixture.whenStable();
    http.expectOne('/api/account/me').flush(customerMe());
    await fixture.whenStable();
    fixture.detectChanges();
    expect(link().getAttribute('aria-label')).toBe('החשבון שלי');
    expect(link().getAttribute('href')).toBe('/account/orders');
  });

  it('the server render never reads the session and shows the signed-out icon', async () => {
    const { fixture, http, link } = setup('server');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    http.expectNone('/api/account/me');
    expect(link().getAttribute('aria-label')).toBe('התחברות');
  });
});
