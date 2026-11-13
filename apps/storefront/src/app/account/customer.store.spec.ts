import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CustomerStore } from './customer.store';
import { customerMe, flushCarts, provideAccountTesting } from './account.testing';

describe('CustomerStore', () => {
  it('loads the customer from /api/account/me in the browser', async () => {
    const http = provideAccountTesting();
    const store = TestBed.inject(CustomerStore);
    expect(store.me()).toBeNull();
    expect(store.ready()).toBe(false);
    const done = store.load();
    http.expectOne('/api/account/me').flush(customerMe());
    await done;
    expect(store.me()?.fullName).toBe('דנה כהן');
    expect(store.ready()).toBe(true);
  });

  it('a signed-out answer (null) is ready with no customer', async () => {
    const http = provideAccountTesting();
    const store = TestBed.inject(CustomerStore);
    const done = store.load();
    http.expectOne('/api/account/me').flush(null);
    await done;
    expect(store.me()).toBeNull();
    expect(store.ready()).toBe(true);
  });

  it('shares one read and reads only once', async () => {
    const http = provideAccountTesting();
    const store = TestBed.inject(CustomerStore);
    const a = store.load();
    const b = store.load();
    http.expectOne('/api/account/me').flush(customerMe());
    await Promise.all([a, b]);
    await store.load();
    http.expectNone('/api/account/me');
  });

  it('never reads the session in the server render', async () => {
    const http = provideAccountTesting([{ provide: PLATFORM_ID, useValue: 'server' }]);
    const store = TestBed.inject(CustomerStore);
    await store.load();
    http.expectNone('/api/account/me');
    expect(store.me()).toBeNull();
    expect(store.ready()).toBe(false);
  });

  it('a failed read leaves the customer signed out', async () => {
    const http = provideAccountTesting();
    const store = TestBed.inject(CustomerStore);
    const done = store.load();
    http.expectOne('/api/account/me').flush({}, { status: 500, statusText: 'Error' });
    await done;
    expect(store.me()).toBeNull();
    expect(store.ready()).toBe(true);
  });

  it('signing in stores the customer and reloads the cart', async () => {
    const http = provideAccountTesting();
    const store = TestBed.inject(CustomerStore);
    store.setCustomer(customerMe());
    expect(store.me()?.email).toBe('dana@example.com');
    expect(http.match('/api/cart')).toHaveLength(1);
  });

  it('signing out posts, clears the customer and reloads the cart', async () => {
    const http = provideAccountTesting();
    const store = TestBed.inject(CustomerStore);
    store.setCustomer(customerMe());
    flushCarts(http);
    const done = store.signOut();
    const req = http.expectOne('/api/account/sign-out');
    expect(req.request.method).toBe('POST');
    req.flush(null, { status: 204, statusText: 'No Content' });
    await done;
    expect(store.me()).toBeNull();
    expect(http.match('/api/cart')).toHaveLength(1);
  });
});
