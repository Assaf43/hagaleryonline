/**
 * Cache behind an interface (architecture.md §2): in-process memory for the MVP,
 * swappable for Redis later without touching callers.
 */
export abstract class CacheStore {
  abstract get<T>(key: string): Promise<T | undefined>;
  abstract set<T>(key: string, value: T, ttlMs: number): Promise<void>;
  /** Deletes every key that starts with `prefix`. */
  abstract invalidate(prefix: string): Promise<void>;

  /** Returns the cached value, or computes, stores and returns it. Concurrent misses share one computation. */
  abstract wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T>;
}

export class InMemoryCacheStore extends CacheStore {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly pending = new Map<string, Promise<unknown>>();

  constructor(private readonly now: () => number = Date.now) {
    super();
  }

  async get<T>(key: string): Promise<T | undefined> {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  async set<T>(key: string, value: T, ttlMs: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  async invalidate(prefix: string): Promise<void> {
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) this.entries.delete(key);
    }
  }

  async wrap<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
    const cached = await this.get<T>(key);
    if (cached !== undefined) return cached;

    const inFlight = this.pending.get(key);
    if (inFlight) return inFlight as Promise<T>;

    const promise = compute()
      .then(async (value) => {
        await this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => this.pending.delete(key));
    this.pending.set(key, promise);
    return promise;
  }
}
