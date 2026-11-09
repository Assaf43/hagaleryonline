import { PLATFORM_ID } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { FAVORITES_KEY, FAVORITES_MAX, FavoritesStore } from './favorites.store';

function store(platform: 'browser' | 'server' = 'browser'): FavoritesStore {
  TestBed.configureTestingModule({ providers: [{ provide: PLATFORM_ID, useValue: platform }] });
  return TestBed.inject(FavoritesStore);
}

const saved = () => JSON.parse(localStorage.getItem(FAVORITES_KEY) ?? 'null') as unknown;

describe('FavoritesStore', () => {
  beforeEach(() => localStorage.clear());
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
});
