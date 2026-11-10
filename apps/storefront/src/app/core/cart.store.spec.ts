import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { CartStore } from './cart.store';
import { cartLine, cartView } from './cart.testing';

function setup(platform: 'browser' | 'server' = 'browser') {
  TestBed.configureTestingModule({
    providers: [{ provide: PLATFORM_ID, useValue: platform }, provideHttpClient(), provideHttpClientTesting()],
  });
  return { store: TestBed.inject(CartStore), http: TestBed.inject(HttpTestingController) };
}

describe('CartStore', () => {
  it('starts empty and does not call the API until load()', () => {
    const { store, http } = setup();
    expect(store.view()).toBeNull();
    expect(store.count()).toBe(0);
    expect(store.miniCartOpen()).toBe(false);
    http.expectNone('/api/cart');
  });

  it('load() reads the cart in the browser', async () => {
    const { store, http } = setup();
    const done = store.load();
    http.expectOne({ method: 'GET', url: '/api/cart' }).flush(cartView([cartLine(1, 2)]));
    await done;
    expect(store.view()?.lines).toHaveLength(1);
    expect(store.count()).toBe(2);
  });

  it('a load that started before a write does not overwrite the newer cart', async () => {
    const { store, http } = setup();
    const loading = store.load();
    const adding = store.add(7, 2);
    http.expectOne('/api/cart/items').flush(cartView([cartLine(7, 2)]));
    await adding;
    // The older read (without the new line) answers last.
    http.expectOne('/api/cart').flush(cartView());
    await loading;
    expect(store.count()).toBe(2);
    expect(store.view()?.lines.map((l) => l.variantId)).toEqual([7]);
  });

  it('a failed load keeps the cart empty', async () => {
    const { store, http } = setup();
    const done = store.load();
    http.expectOne('/api/cart').flush({}, { status: 500, statusText: 'Server Error' });
    await done;
    expect(store.view()).toBeNull();
    expect(store.count()).toBe(0);
    expect(store.loadFailed()).toBe(true);
  });

  it('a later successful load clears the failed state', async () => {
    const { store, http } = setup();
    const first = store.load();
    http.expectOne('/api/cart').flush({}, { status: 500, statusText: 'Server Error' });
    await first;
    const second = store.load();
    expect(store.loadFailed()).toBe(false);
    http.expectOne('/api/cart').flush(cartView());
    await second;
    expect(store.loadFailed()).toBe(false);
  });

  it('add() posts the line and updates the view and count', async () => {
    const { store, http } = setup();
    const done = store.add(7, 3);
    const req = http.expectOne({ method: 'POST', url: '/api/cart/items' });
    expect(req.request.body).toEqual({ variantId: 7, quantity: 3 });
    req.flush(cartView([cartLine(7, 3)]));
    const view = await done;
    expect(view.itemCount).toBe(3);
    expect(store.view()).toBe(view);
    expect(store.count()).toBe(3);
  });

  it('add() rejects on an API error and keeps the last view', async () => {
    const { store, http } = setup();
    const first = store.add(1, 1);
    http.expectOne('/api/cart/items').flush(cartView([cartLine(1, 1)]));
    await first;
    const failed = store.add(2, 1);
    http.expectOne('/api/cart/items').flush({}, { status: 500, statusText: 'Server Error' });
    await expect(failed).rejects.toBeTruthy();
    expect(store.count()).toBe(1);
  });

  it('setQuantity() and remove() update the view', async () => {
    const { store, http } = setup();
    const set = store.setQuantity(7, 5);
    const patch = http.expectOne({ method: 'PATCH', url: '/api/cart/items/7' });
    expect(patch.request.body).toEqual({ quantity: 5 });
    patch.flush(cartView([cartLine(7, 5)]));
    await set;
    expect(store.count()).toBe(5);

    const removed = store.remove(7);
    http.expectOne({ method: 'DELETE', url: '/api/cart/items/7' }).flush(cartView());
    await removed;
    expect(store.count()).toBe(0);
    expect(store.view()?.lines).toEqual([]);
  });

  it('two concurrent load() calls share one request', async () => {
    const { store, http } = setup();
    const a = store.load();
    const b = store.load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1)]));
    await Promise.all([a, b]);
    http.verify();
    expect(store.count()).toBe(1);
    // Once it answered, the next load() is a new request.
    const c = store.load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2)]));
    await c;
    expect(store.count()).toBe(2);
  });

  it('keeps one-time notices from an earlier load that a later load lacks, while their line exists', async () => {
    const { store, http } = setup();
    const price = { variantId: 1, kind: 'price_changed' as const, messageHe: 'המחיר של MODEL1 עודכן' };
    const clamped = { variantId: 2, kind: 'quantity_clamped' as const, messageHe: 'נשארו רק 1 במלאי' };
    const unavailable = { variantId: 3, kind: 'unavailable' as const, messageHe: 'MODEL3 אזל מהמלאי' };
    const a = store.load();
    http
      .expectOne('/api/cart')
      .flush(cartView([cartLine(1, 1), cartLine(2, 1), cartLine(3, 1)], [price, clamped, unavailable]));
    await a;

    // A background load (e.g. the header's) no longer sees them: they stay; line 2 is gone, so its notice goes.
    const b = store.load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1), cartLine(3, 1)]));
    await b;
    expect(store.view()?.notices).toEqual([price]);
  });

  it('a write clears carried notices', async () => {
    const { store, http } = setup();
    const price = { variantId: 1, kind: 'price_changed' as const, messageHe: 'המחיר של MODEL1 עודכן' };
    const a = store.load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1)], [price]));
    await a;
    const b = store.load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 1)]));
    await b;
    expect(store.view()?.notices).toEqual([price]);

    const set = store.setQuantity(1, 2);
    http.expectOne('/api/cart/items/1').flush(cartView([cartLine(1, 2)]));
    await set;
    expect(store.view()?.notices).toEqual([]);
    const c = store.load();
    http.expectOne('/api/cart').flush(cartView([cartLine(1, 2)]));
    await c;
    expect(store.view()?.notices).toEqual([]);
  });

  it('a load() after a write does not reuse a read that started before it', async () => {
    const { store, http } = setup();
    const stale = store.load();
    const adding = store.add(7, 1);
    http.expectOne('/api/cart/items').flush(cartView([cartLine(7, 1)]));
    await adding;
    const fresh = store.load();
    const reqs = http.match('/api/cart');
    expect(reqs).toHaveLength(2);
    reqs[0].flush(cartView());
    reqs[1].flush(cartView([cartLine(7, 3)]));
    await Promise.all([stale, fresh]);
    expect(store.count()).toBe(3);
  });

  it('never calls the API on the server', async () => {
    const { store, http } = setup('server');
    await store.load();
    await expect(store.add(1, 1)).rejects.toBeTruthy();
    await expect(store.setQuantity(1, 2)).rejects.toBeTruthy();
    await expect(store.remove(1)).rejects.toBeTruthy();
    http.verify();
    expect(store.view()).toBeNull();
  });
});
