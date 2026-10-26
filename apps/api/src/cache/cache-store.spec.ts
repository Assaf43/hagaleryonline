import { InMemoryCacheStore } from './cache-store.js';

describe('InMemoryCacheStore', () => {
  it('expires entries after their TTL', async () => {
    let now = 1_000;
    const cache = new InMemoryCacheStore(() => now);
    await cache.set('a', 1, 100);
    expect(await cache.get('a')).toBe(1);
    now += 100;
    expect(await cache.get('a')).toBeUndefined();
  });

  it('runs one computation for concurrent misses', async () => {
    const cache = new InMemoryCacheStore();
    const compute = vi.fn(async () => 'value');
    const results = await Promise.all([cache.wrap('k', 1_000, compute), cache.wrap('k', 1_000, compute)]);
    expect(results).toEqual(['value', 'value']);
    expect(compute).toHaveBeenCalledTimes(1);
  });

  it('invalidates by prefix', async () => {
    const cache = new InMemoryCacheStore();
    await cache.set('catalog:a', 1, 1_000);
    await cache.set('catalog:b', 2, 1_000);
    await cache.set('other', 3, 1_000);
    await cache.invalidate('catalog:');
    expect(await cache.get('catalog:a')).toBeUndefined();
    expect(await cache.get('other')).toBe(3);
  });
});
