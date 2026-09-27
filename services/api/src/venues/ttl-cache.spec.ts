/**
 * TtlCache (SEN-70): the three properties the market-data read path leans on —
 * one load per TTL, one load per burst, and a flagged stale value when a
 * reload fails inside the grace window.
 */
import { TtlCache } from './ttl-cache';

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('TtlCache', () => {
  it('loads once within the TTL and again after it', async () => {
    const c = clock();
    const cache = new TtlCache<string, number>({ now: c.now });
    const load = jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

    expect(await cache.get('k', 1000, load)).toEqual({ value: 1, stale: false, loadedAt: c.now() });
    c.advance(999);
    expect((await cache.get('k', 1000, load)).value).toBe(1);
    expect(load).toHaveBeenCalledTimes(1);

    c.advance(1);
    expect((await cache.get('k', 1000, load)).value).toBe(2);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent loads of one key into a single flight', async () => {
    const cache = new TtlCache<string, string>();
    let release!: (value: string) => void;
    const load = jest.fn(() => new Promise<string>((resolve) => (release = resolve)));

    const reads = Promise.all([1, 2, 3, 4, 5].map(() => cache.get('k', 1000, load)));
    release('book');
    const results = await reads;

    expect(load).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.value)).toEqual(['book', 'book', 'book', 'book', 'book']);
  });

  it('keeps keys independent', async () => {
    const cache = new TtlCache<string, string>();
    const load = jest.fn((key: string) => Promise.resolve(key));
    await cache.get('a', 1000, () => load('a'));
    await cache.get('b', 1000, () => load('b'));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('serves the last good value flagged stale when a reload fails inside the window', async () => {
    const c = clock();
    const cache = new TtlCache<string, number>({ now: c.now });
    await cache.get('k', 1000, () => Promise.resolve(7));
    const loadedAt = c.now();
    c.advance(1500);

    const failing = () => Promise.reject(new Error('rpc down'));
    expect(await cache.get('k', 1000, failing, { staleIfErrorMs: 1000 })).toEqual({
      value: 7,
      stale: true,
      loadedAt,
    });

    // Past ttl + staleIfErrorMs the error surfaces: an old price is not a price.
    c.advance(500);
    await expect(cache.get('k', 1000, failing, { staleIfErrorMs: 1000 })).rejects.toThrow(
      'rpc down',
    );
  });

  it('propagates a failure when there is nothing to fall back on, and retries next time', async () => {
    const cache = new TtlCache<string, number>();
    await expect(
      cache.get('k', 1000, () => Promise.reject(new Error('boom')), { staleIfErrorMs: 60_000 }),
    ).rejects.toThrow('boom');
    expect((await cache.get('k', 1000, () => Promise.resolve(3))).value).toBe(3);
  });

  it('evicts the oldest entry past maxEntries', async () => {
    const cache = new TtlCache<string, number>({ maxEntries: 2 });
    for (const key of ['a', 'b', 'c']) await cache.get(key, 1000, () => Promise.resolve(1));
    expect(cache.size).toBe(2);
    const load = jest.fn(() => Promise.resolve(2));
    await cache.get('a', 1000, load);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
