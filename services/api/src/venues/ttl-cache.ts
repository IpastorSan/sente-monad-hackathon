/**
 * A per-key TTL cache with single-flight loads and stale-if-error (SEN-70).
 *
 * Market data is read by every open phone and every agent run, and the venues
 * behind it are rate-limited RPC and REST endpoints. Three properties keep that
 * load flat:
 *
 * - **TTL per call, not per cache**: the same book is 2 s fresh for a ticker and
 *   the same cache holds klines at 10–60 s, so the caller names the TTL.
 * - **Single-flight**: N concurrent readers of one expired key cause ONE load,
 *   not N — a burst of app opens must not become a burst of RPC calls.
 * - **Stale-if-error**: when a reload fails, the last good value is served for
 *   up to `staleIfErrorMs` past its expiry, flagged `stale`, so a venue hiccup
 *   degrades the screen instead of blanking it. Past that window the error
 *   propagates: an old price shown as current is worse than no price.
 */

export type CacheResult<V> = {
  readonly value: V;
  /** True when the value is past its TTL and is being served because a reload failed. */
  readonly stale: boolean;
  /** When the value was loaded (epoch ms). */
  readonly loadedAt: number;
};

export type TtlCacheOptions = {
  readonly now?: () => number;
  /**
   * Entries kept before the oldest-inserted is evicted. Keys can carry a
   * caller-chosen part (a klines `endTime`), so the map must not grow forever.
   */
  readonly maxEntries?: number;
};

type Entry<V> = { value: V; loadedAt: number };

export class TtlCache<K, V> {
  readonly #now: () => number;
  readonly #maxEntries: number;
  readonly #entries = new Map<K, Entry<V>>();
  readonly #inflight = new Map<K, Promise<CacheResult<V>>>();

  constructor(options: TtlCacheOptions = {}) {
    // Read through a closure so a spied `Date.now` (specs) is honoured.
    this.#now = options.now ?? (() => Date.now());
    this.#maxEntries = options.maxEntries ?? 1000;
  }

  get(
    key: K,
    ttlMs: number,
    load: () => Promise<V>,
    options: { staleIfErrorMs?: number } = {},
  ): Promise<CacheResult<V>> {
    const entry = this.#entries.get(key);
    if (entry && this.#now() - entry.loadedAt < ttlMs) {
      return Promise.resolve({ value: entry.value, stale: false, loadedAt: entry.loadedAt });
    }
    const pending = this.#inflight.get(key);
    if (pending) return pending;

    const flight = this.#load(key, ttlMs, load, options.staleIfErrorMs ?? 0).finally(() =>
      this.#inflight.delete(key),
    );
    this.#inflight.set(key, flight);
    return flight;
  }

  get size(): number {
    return this.#entries.size;
  }

  async #load(
    key: K,
    ttlMs: number,
    load: () => Promise<V>,
    staleIfErrorMs: number,
  ): Promise<CacheResult<V>> {
    try {
      const value = await load();
      const loadedAt = this.#now();
      // Re-insert so Map order tracks recency of loads, which is what eviction reads.
      this.#entries.delete(key);
      this.#entries.set(key, { value, loadedAt });
      this.#evict();
      return { value, stale: false, loadedAt };
    } catch (error) {
      const last = this.#entries.get(key);
      if (last && this.#now() - last.loadedAt < ttlMs + staleIfErrorMs) {
        return { value: last.value, stale: true, loadedAt: last.loadedAt };
      }
      throw error;
    }
  }

  #evict(): void {
    while (this.#entries.size > this.#maxEntries) {
      const oldest = this.#entries.keys().next();
      if (oldest.done) return;
      this.#entries.delete(oldest.value);
    }
  }
}
