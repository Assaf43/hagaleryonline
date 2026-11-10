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

  afterEach(() => {
    document.body.innerHTML = '';
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

  it('shows "הסל ריק" when empty', async () => {
    const { dialog } = await setup(cartView());
    expect(dialog.textContent).toContain('הסל ריק');
    expect(dialog.querySelector('.line')).toBeNull();
    expect(dialog.querySelector('.subtotal')).toBeNull();
    expect(dialog.querySelector('a[href="/checkout"]')).toBeNull();
  });
});
