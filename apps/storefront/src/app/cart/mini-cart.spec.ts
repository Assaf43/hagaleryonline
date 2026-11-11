import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter } from '@angular/router';
import { CartStore } from '../core/cart.store';
import { cartLine, cartView } from '../core/cart.testing';
import { MiniCart } from './mini-cart';

@Component({
  imports: [MiniCart],
  template: `<button type="button" class="opener" (click)="open()">סל</button><hg-mini-cart />`,
})
class Host {
  private readonly store = TestBed.inject(CartStore);
  open() {
    this.store.miniCartOpen.set(true);
  }
}

describe('MiniCart', () => {
  async function setup(view = cartView([cartLine(1, 2, 150000), cartLine(2, 1, 99000)])) {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const store = TestBed.inject(CartStore);
    const http = TestBed.inject(HttpTestingController);
    const loading = store.load();
    http.expectOne('/api/cart').flush(view);
    await loading;
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const opener = el.querySelector<HTMLButtonElement>('.opener')!;
    opener.focus();
    opener.click();
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return { fixture, el, store, opener, dialog: el.querySelector('dialog')! };
  }

  // jsdom has no modal dialog: a minimal stand-in that keeps the `open` attribute and the close event.
  const proto = HTMLDialogElement.prototype as Partial<HTMLDialogElement>;
  const native = { showModal: proto.showModal, close: proto.close };
  beforeEach(() => {
    proto.showModal = function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    proto.close = function (this: HTMLDialogElement) {
      this.removeAttribute('open');
      this.dispatchEvent(new Event('close'));
    };
  });

  afterEach(() => {
    proto.showModal = native.showModal;
    proto.close = native.close;
    document.body.innerHTML = '';
  });

  it('shows the lowest shipping price under the subtotal once the cart has one', async () => {
    const without = await setup();
    expect(without.dialog.querySelector('.shipping-from')).toBeNull();
    document.body.innerHTML = '';
    TestBed.resetTestingModule();
    const view = cartView([cartLine(1, 2, 150000)]);
    view.shippingFrom = 25000;
    const { dialog } = await setup(view);
    const line = dialog.querySelector('.foot .subtotal + .shipping-from');
    expect(line?.textContent?.replace(/\s+/g, ' ').trim()).toBe('משלוח החל מ־250 ₪');
  });

  it('shows the discount line under the subtotal', async () => {
    const view = cartView([cartLine(1, 2, 150000)]);
    view.discount = { labelHe: 'קופון חורף', amount: 25000, source: 'coupon', code: 'WINTER' };
    view.couponCode = 'WINTER';
    const { dialog } = await setup(view);
    const row = dialog.querySelector('.foot .subtotal + .discount-row');
    expect(row?.textContent?.replace(/\s+/g, ' ').trim()).toBe('קופון חורף: −250 ₪');
  });

  it('opens with the title, the lines and the subtotal', async () => {
    const { dialog } = await setup();
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBeTruthy();
    expect(dialog.querySelector('h2')?.textContent?.trim()).toBe('סל הקניות');
    const lines = dialog.querySelectorAll('.line');
    expect(lines).toHaveLength(2);
    const first = lines[0];
    expect(first.querySelector('img')?.getAttribute('src')).toBe('/media/1.webp');
    expect(first.querySelector('bdi[dir="ltr"]')?.textContent?.trim()).toBe('MODEL1');
    expect(first.textContent).toContain('בז׳ · 280 ס״מ');
    expect(first.textContent).toContain('כמות: 2');
    expect(first.textContent).toContain('3,000 ₪');
    expect(dialog.querySelector('.subtotal')?.textContent).toContain('סכום ביניים');
    expect(dialog.querySelector('.subtotal')?.textContent).toContain('3,990 ₪');
    const links = Array.from(dialog.querySelectorAll('a.btn'));
    expect(links.map((a) => [a.textContent?.trim(), a.getAttribute('href')])).toEqual([
      ['לסל', '/cart'],
      ['למעבר לתשלום', '/checkout'],
    ]);
  });

  it('moves focus into the dialog and traps it there', async () => {
    const { dialog } = await setup();
    expect(dialog.contains(document.activeElement)).toBe(true);
    // CDK focus trap anchors around the panel.
    expect(dialog.querySelectorAll('.cdk-focus-trap-anchor').length).toBe(2);
  });

  it('Escape closes it and returns focus to the opener', async () => {
    const { fixture, dialog, store, opener } = await setup();
    dialog.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    fixture.detectChanges();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(store.miniCartOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('the close button closes it and returns focus to the opener', async () => {
    const { fixture, dialog, store, opener } = await setup();
    dialog.querySelector<HTMLButtonElement>('button[aria-label="סגירת סל הקניות"]')!.click();
    fixture.detectChanges();
    expect(dialog.hasAttribute('open')).toBe(false);
    expect(store.miniCartOpen()).toBe(false);
    expect(document.activeElement).toBe(opener);
  });

  it('shows the notices from the server', async () => {
    const view = cartView(
      [cartLine(1, 3)],
      [{ variantId: 1, kind: 'quantity_clamped', messageHe: 'נשארו במלאי רק 3 יחידות' }],
    );
    const { dialog } = await setup(view);
    expect(dialog.querySelector('.notices')?.textContent).toContain('נשארו במלאי רק 3 יחידות');
  });

  it('marks unavailable lines with text, not only colour, and without a line total', async () => {
    const view = cartView([
      { ...cartLine(1, 1), available: false, unavailableReason: 'sold_out' },
      { ...cartLine(2, 1), available: false, unavailableReason: 'hidden' },
    ]);
    view.itemCount = 0;
    view.subtotal = 0;
    const { dialog } = await setup(view);
    const lines = dialog.querySelectorAll('.line');
    expect(lines[0].querySelector('.unavailable-label')?.textContent?.trim()).toBe('אזל מהמלאי');
    expect(lines[1].querySelector('.unavailable-label')?.textContent?.trim()).toBe('לא זמין');
    expect(dialog.querySelector('.line-price')).toBeNull();
  });

  it('checkout is aria-disabled and not a link when no line is available', async () => {
    const view = cartView([{ ...cartLine(1, 1), available: false, unavailableReason: 'sold_out' }]);
    view.itemCount = 0;
    view.subtotal = 0;
    const { dialog } = await setup(view);
    const checkout = dialog.querySelector<HTMLElement>('.checkout')!;
    expect(checkout.textContent?.trim()).toBe('למעבר לתשלום');
    expect(checkout.getAttribute('aria-disabled')).toBe('true');
    expect(checkout.getAttribute('href')).toBeNull();
    expect(dialog.querySelector('a[href="/cart"]')).not.toBeNull();
  });

  it('keeps the polite notices region in the DOM even without notices', async () => {
    const { dialog } = await setup();
    const region = dialog.querySelector('.notices');
    expect(region?.getAttribute('aria-live')).toBe('polite');
    expect(region?.children.length).toBe(0);
  });

  it('opened before the cart arrived: shows "טוען…", loads it, then the lines', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const store = TestBed.inject(CartStore);
    const http = TestBed.inject(HttpTestingController);
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    store.miniCartOpen.set(true);
    fixture.detectChanges();
    const dialog = (fixture.nativeElement as HTMLElement).querySelector('dialog')!;
    expect(dialog.textContent).toContain('טוען…');
    expect(dialog.textContent).not.toContain('הסל ריק');
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1)]));
    await fixture.whenStable();
    await new Promise((resolve) => setTimeout(resolve));
    fixture.detectChanges();
    expect(dialog.textContent).not.toContain('טוען…');
    expect(dialog.querySelectorAll('.line')).toHaveLength(1);
  });

  it('shows "הסל ריק" when empty', async () => {
    const { dialog } = await setup(cartView());
    expect(dialog.textContent).toContain('הסל ריק');
    expect(dialog.querySelector('.line')).toBeNull();
    expect(dialog.querySelector('.subtotal')).toBeNull();
    expect(dialog.querySelector('a[href="/checkout"]')).toBeNull();
  });

  it('shows a retry instead of "טוען…" when the cart cannot be loaded', async () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), provideRouter([])] });
    const store = TestBed.inject(CartStore);
    const http = TestBed.inject(HttpTestingController);
    const loading = store.load();
    http.expectOne('/api/cart').flush({}, { status: 500, statusText: 'Server Error' });
    await loading;
    const fixture = TestBed.createComponent(Host);
    document.body.appendChild(fixture.nativeElement);
    fixture.detectChanges();
    store.miniCartOpen.set(true);
    fixture.detectChanges();
    // Opening with no cart yet reads it again; that read fails too.
    http.expectOne('/api/cart').flush({}, { status: 500, statusText: 'Server Error' });
    await fixture.whenStable();
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).toContain('לא הצלחנו לטעון את הסל.');
    expect(el.textContent).not.toContain('טוען…');
    el.querySelector<HTMLButtonElement>('button.retry')!.click();
    http.expectOne('/api/cart').flush(cartView());
  });
});
