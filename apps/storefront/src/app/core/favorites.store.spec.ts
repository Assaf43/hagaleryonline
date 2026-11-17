import { PLATFORM_ID, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import type { CustomerMe } from '@hg/models';
import { AccountApi } from '../account/account.api';
import { CustomerStore } from '../account/customer.store';
import { FAVORITES_KEY, FAVORITES_MAX, FavoritesStore } from './favorites.store';

/** The signed-in customer, as the fake `CustomerStore` shows it. */
const me = signal<CustomerMe | null>(null);
/** The account's favorites on the fake server, newest first. */
let server: Record<string, number[]> = {};
let api: {
  mergeFavorites: ReturnType<typeof vi.fn>;
  favorites: ReturnType<typeof vi.fn>;
  removeFavorite: ReturnType<typeof vi.fn>;
};
const customer = (id: string) => ({ id }) as CustomerMe;

function store(platform: 'browser' | 'server' = 'browser'): FavoritesStore {
  const current = () => me()!.id;
  api = {
    mergeFavorites: vi.fn(async (ids: number[]) => {
      const mine = server[current()] ?? [];
      return (server[current()] = [...ids.filter((i) => !mine.includes(i)), ...mine].slice(0, FAVORITES_MAX));
    }),
    favorites: vi.fn(async () => server[current()] ?? []),
    removeFavorite: vi.fn(async (id: number) => {
      server[current()] = (server[current()] ?? []).filter((i) => i !== id);
    }),
  };
  TestBed.configureTestingModule({
    providers: [
      { provide: PLATFORM_ID, useValue: platform },
      { provide: CustomerStore, useValue: { me: me.asReadonly() } },
      { provide: AccountApi, useValue: api },
    ],
  });
  return TestBed.inject(FavoritesStore);
}

/** Lets the effect run and the fake server's promises settle. */
const settle = async () => {
  TestBed.tick();
  await new Promise((r) => setTimeout(r));
};

const saved = () => JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? 'null') as unknown;

describe('FavoritesStore', () => {
  beforeEach(() => {
    localStorage.clear();
    me.set(null);
    server = {};
  });
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it('toggles and keeps newest first', () => {
    const s = store();
    s.toggle(1);
    s.toggle(2);
    s.toggle(3);
    expect(s.ids()).toEqual([3, 2, 1]);
    expect(s.count()).toBe(3);
    expect(s.has(2)).toBe(true);
    expect(saved()).toEqual([3, 2, 1]);

    s.toggle(2);
    expect(s.ids()).toEqual([3, 1]);
    expect(s.has(2)).toBe(false);
    s.toggle(2);
    expect(s.ids()).toEqual([2, 3, 1]);

    s.remove([3, 1, 99]);
    expect(s.ids()).toEqual([2]);
    expect(saved()).toEqual([2]);
  });

  it('caps at 100 dropping the oldest', () => {
    const s = store();
    for (let id = 1; id <= FAVORITES_MAX + 1; id++) s.toggle(id);
    expect(FAVORITES_MAX).toBe(100);
    expect(s.count()).toBe(100);
    expect(s.ids()[0]).toBe(101);
    expect(s.has(1)).toBe(false);
    expect(s.has(2)).toBe(true);
    expect((saved() as number[]).length).toBe(100);
  });

  it('reads only valid unique numeric ids from corrupt storage', () => {
    for (const [raw, expected] of [
      ['nope', []],
      ['{"a":1}', []],
      ['[3,"x",3,-1,2.5,4]', [3, 4]],
    ] as const) {
      TestBed.resetTestingModule();
      localStorage.setItem(FAVORITES_KEY, raw);
      expect(store().ids()).toEqual(expected);
    }
  });

  it('works in memory when localStorage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const s = store();
    expect(s.ids()).toEqual([]);
    s.toggle(7);
    s.toggle(8);
    expect(s.ids()).toEqual([8, 7]);
    s.remove([7]);
    expect(s.ids()).toEqual([8]);
  });

  it('follows the storage event from another tab', () => {
    const s = store();
    s.toggle(1);
    window.dispatchEvent(new StorageEvent('storage', { key: FAVORITES_KEY, newValue: '[5,6]' }));
    expect(s.ids()).toEqual([5, 6]);
    window.dispatchEvent(new StorageEvent('storage', { key: 'other', newValue: '[9]' }));
    expect(s.ids()).toEqual([5, 6]);
    // localStorage.clear() in the other tab sends key null.
    window.dispatchEvent(new StorageEvent('storage', { key: null, newValue: null }));
    expect(s.ids()).toEqual([]);
  });

  it('is empty on the server', () => {
    localStorage.setItem(FAVORITES_KEY, '[1,2]');
    const getItem = vi.spyOn(Storage.prototype, 'getItem');
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const s = store('server');
    expect(s.ids()).toEqual([]);
    expect(s.count()).toBe(0);
    s.toggle(3);
    expect(getItem).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(s.ids()).toEqual([]);
  });

  describe('signed in (CLB-09)', () => {
    it('merges the device list into the account on sign-in and shows the server list', async () => {
      localStorage.setItem(FAVORITES_KEY, '[3,2]');
      server = { a: [9, 2] };
      const s = store();
      await settle();
      expect(s.source()).toBe('device');
      me.set(customer('a'));
      await settle();
      expect(api.mergeFavorites).toHaveBeenCalledWith([3, 2]);
      expect(s.ids()).toEqual([3, 9, 2]);
      expect(s.source()).toBe('a');
      // The device list is left as it was.
      expect(saved()).toEqual([3, 2]);
    });

    it('writes through while signed in; a removal also leaves the device list', async () => {
      localStorage.setItem(FAVORITES_KEY, '[1]');
      const s = store();
      me.set(customer('a'));
      await settle();
      s.toggle(5);
      expect(s.ids()).toEqual([5, 1]);
      await settle();
      expect(api.mergeFavorites).toHaveBeenLastCalledWith([5]);
      expect(server['a']).toEqual([5, 1]);
      s.toggle(1);
      expect(s.has(1)).toBe(false);
      await settle();
      expect(api.removeFavorite).toHaveBeenCalledWith(1);
      expect(server['a']).toEqual([5]);
      // A removal also leaves the device list; an add does not enter it.
      expect(saved()).toEqual([]);
    });

    it('shows the device list again on sign-out, and another account never sees the earlier account list', async () => {
      localStorage.setItem(FAVORITES_KEY, '[1]');
      const s = store();
      me.set(customer('a'));
      await settle();
      s.toggle(7);
      await settle();
      expect(s.ids()).toEqual([7, 1]);
      me.set(null);
      await settle();
      expect(s.ids()).toEqual([1]);
      expect(s.source()).toBe('device');
      me.set(customer('b'));
      await settle();
      expect(s.ids()).toEqual([1]);
      expect(server['b']).toEqual([1]);
      expect(server['a']).toEqual([7, 1]);
    });

    it('keeps the device list when the merge fails, and reads the account again after a failed write', async () => {
      localStorage.setItem(FAVORITES_KEY, '[1]');
      const s = store();
      api.mergeFavorites.mockRejectedValueOnce(new Error('offline'));
      me.set(customer('a'));
      await settle();
      expect(s.ids()).toEqual([1]);
      expect(s.source()).toBe('device');

      me.set(null);
      await settle();
      me.set(customer('b'));
      await settle();
      expect(s.source()).toBe('b');
      api.mergeFavorites.mockRejectedValueOnce(new Error('offline'));
      s.toggle(8);
      expect(s.ids()).toEqual([8, 1]);
      await settle();
      expect(api.favorites).toHaveBeenCalled();
      expect(s.ids()).toEqual([1]);
    });

    it('merges once per device and account: a reload does not bring a removed favorite back', async () => {
      localStorage.setItem(FAVORITES_KEY, '[2,1]');
      me.set(customer('a'));
      let s = store();
      await settle();
      expect(api.mergeFavorites).toHaveBeenCalledTimes(1);
      s.toggle(1);
      await settle();
      expect(server['a']).toEqual([2]);
      expect(saved()).toEqual([2]);

      // A reload: a new store, the session is still there.
      TestBed.resetTestingModule();
      s = store();
      await settle();
      expect(api.mergeFavorites).not.toHaveBeenCalled();
      expect(api.favorites).toHaveBeenCalled();
      expect(s.ids()).toEqual([2]);
      expect(s.source()).toBe('a');
      expect(server['a']).toEqual([2]);
    });

    it('merges the device list once for each different account on the same device', async () => {
      localStorage.setItem(FAVORITES_KEY, '[1]');
      me.set(customer('a'));
      store();
      await settle();
      me.set(null);
      await settle();
      me.set(customer('b'));
      await settle();
      expect(api.mergeFavorites).toHaveBeenCalledTimes(2);
      expect(server['b']).toEqual([1]);
      TestBed.resetTestingModule();
      store();
      await settle();
      expect(api.mergeFavorites).not.toHaveBeenCalled();
    });

    it('merges again after a sign-out and a sign-in of the same account', async () => {
      localStorage.setItem(FAVORITES_KEY, '[1]');
      me.set(customer('a'));
      store();
      await settle();
      me.set(null);
      await settle();
      me.set(customer('a'));
      await settle();
      expect(api.mergeFavorites).toHaveBeenCalledTimes(2);
    });

    it('works without localStorage for the merge marker', async () => {
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      me.set(customer('a'));
      const s = store();
      await settle();
      expect(api.mergeFavorites).toHaveBeenCalledTimes(1);
      expect(s.source()).toBe('a');
    });

    it('ignores a merge that answers after the customer changed', async () => {
      const s = store();
      let finish!: (ids: number[]) => void;
      api.mergeFavorites.mockImplementationOnce(() => new Promise<number[]>((r) => (finish = r)));
      me.set(customer('a'));
      await settle();
      me.set(null);
      await settle();
      finish([42]);
      await settle();
      expect(s.ids()).toEqual([]);
      expect(s.source()).toBe('device');
    });
  });
});
