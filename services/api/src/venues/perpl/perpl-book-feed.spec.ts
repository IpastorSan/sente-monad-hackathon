/**
 * PerplBookFeed (SEN-64): one lazily-opened socket, one batched subscribe, a
 * request budget that survives reconnects, and books that age into `stale`.
 */
import type { PerplL2Book, WebSocketFactory, WebSocketLike } from '@sente/venues/perpl';

import { PerplBookFeed, type PerplBookFeedOptions } from './perpl-book-feed';

class FakeSocket implements WebSocketLike {
  readonly sent: Record<string, unknown>[] = [];
  readonly sentAt: number[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
    this.sentAt.push(Date.now());
  }
  close(): void {
    this.closed = true;
  }
  emit(frame: object): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }
  drop(code = 1006): void {
    this.onclose?.({ code, reason: '' });
  }
  subscribes() {
    return this.sent.filter((f) => f.mt === 5) as { subs: { stream: string }[] }[];
  }
}

const book = (sid: number, price = 100): PerplL2Book => ({
  mt: 15,
  sid,
  at: { b: 1 },
  bid: [{ p: price - 1, s: 10, o: 1 }],
  ask: [{ p: price + 1, s: 10, o: 1 }],
});

/** Lets `onopen`'s async `marketIds()` settle. */
const settle = () => jest.advanceTimersByTimeAsync(0);

function setup(overrides: Partial<PerplBookFeedOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const webSocket: WebSocketFactory = (url) => {
    const s = new FakeSocket(url);
    sockets.push(s);
    return s;
  };
  const marketIds = jest.fn(async () => [16, 32, 48]);
  const feed = new PerplBookFeed({
    wsUrl: 'wss://perpl.test',
    marketIds,
    webSocket,
    random: () => 0.5,
    ...overrides,
  });
  const last = () => sockets[sockets.length - 1];
  /** Opens the current socket and acks the subscribe with sid = market id. */
  const openAndAck = async () => {
    last().onopen?.();
    await settle();
    const sub = last().subscribes().at(-1);
    last().emit({
      mt: 6,
      subs: sub?.subs.map((s) => ({
        ...s,
        sid: Number(s.stream.split('@')[1]),
        status: { code: 0 },
      })),
    });
  };
  return { feed, sockets, last, marketIds, openAndAck };
}

describe('PerplBookFeed', () => {
  beforeEach(() => jest.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => jest.useRealTimers());

  it('opens nothing until the first read, then one socket for every reader', () => {
    const { feed, sockets } = setup();
    expect(sockets).toHaveLength(0);
    expect(feed.status().connected).toBe(false);

    expect(feed.book(16)).toBeUndefined();
    feed.book(32);
    expect(sockets).toHaveLength(1);
    expect(sockets[0].url).toBe('wss://perpl.test/ws/v1/market-data');
    feed.close();
  });

  it('sends one subscribe carrying every market and stores snapshots by sid', async () => {
    const { feed, last, openAndAck } = setup();
    feed.book(16);
    await openAndAck();

    expect(last().subscribes()).toHaveLength(1);
    expect(
      last()
        .subscribes()[0]
        .subs.map((s) => s.stream),
    ).toEqual(['order-book@16', 'order-book@32', 'order-book@48']);

    last().emit(book(32, 500));
    const entry = feed.book(32);
    expect(entry).toEqual({ book: book(32, 500), receivedAt: 1_000_000, stale: false });
    expect(feed.status()).toMatchObject({ connected: true, markets: [32], requestsLastMin: 1 });
    feed.close();
  });

  it('resolves waitFor on the first snapshot and rejects on a refused subscription', async () => {
    const { feed, last } = setup();
    const waiting = feed.waitFor(16, 5_000);
    const refused = feed.waitFor(48, 5_000);
    last().onopen?.();
    await settle();
    last().emit({
      mt: 6,
      subs: [
        { stream: 'order-book@16', sid: 16, status: { code: 0 } },
        { stream: 'order-book@32', sid: 32, status: { code: 0 } },
        { stream: 'order-book@48', status: { code: 404, error: 'unknown market' } },
      ],
    });
    last().emit(book(16));

    await expect(waiting).resolves.toMatchObject({ stale: false });
    await expect(refused).rejects.toThrow('order-book@48: 404 unknown market');
    expect(feed.status().subscriptionErrors).toEqual({ 48: '404 unknown market' });
    feed.close();
  });

  it('flags a book stale after staleMs', async () => {
    const { feed, last, openAndAck } = setup({ staleMs: 15_000 });
    feed.book(16);
    await openAndAck();
    last().emit(book(16));

    jest.advanceTimersByTime(15_000);
    expect(feed.book(16)?.stale).toBe(false);
    jest.advanceTimersByTime(1);
    expect(feed.book(16)?.stale).toBe(true);
    feed.close();
  });

  it('re-subscribes a stale market at most every refreshMinMs', async () => {
    const { feed, last, openAndAck } = setup({ staleMs: 5_000, refreshMinMs: 10_000 });
    feed.book(16);
    await openAndAck();
    last().emit(book(16));

    jest.advanceTimersByTime(6_000);
    feed.book(16);
    feed.book(16);
    expect(last().subscribes()).toHaveLength(2);
    expect(last().subscribes()[1].subs).toEqual([
      { stream: 'order-book@16', subscribe: false },
      { stream: 'order-book@16', subscribe: true },
    ]);
    feed.close();
  });

  it('reconnects with exponential backoff and jitter, capped at 60 s', async () => {
    const { feed, sockets, last, openAndAck } = setup({ random: () => 0 });
    feed.book(16);
    await openAndAck();

    // random() = 0 → half the exponential step: 500, 1000, 2000, …, capped.
    const expected = [500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    for (const delay of expected) {
      const before = sockets.length;
      last().drop();
      feed.book(16); // a reader keeps it wanted
      jest.advanceTimersByTime(delay - 1);
      expect(sockets).toHaveLength(before);
      jest.advanceTimersByTime(1);
      expect(sockets).toHaveLength(before + 1);
    }
    expect(feed.status().reconnects).toBe(expected.length);

    const capped = setup({ random: () => 0.999 });
    capped.feed.book(16);
    for (let i = 0; i < 10; i++) {
      const before = capped.sockets.length;
      capped.last().drop();
      capped.feed.book(16);
      jest.advanceTimersByTime(60_000);
      expect(capped.sockets).toHaveLength(before + 1);
    }
    feed.close();
    capped.feed.close();
  });

  it('never exceeds the request budget, across reconnects', async () => {
    const { feed, sockets, last, openAndAck } = setup({ maxRequestsPerMin: 3, random: () => 0 });
    feed.book(16);
    await openAndAck();

    // Five fast drops: every new socket wants its own subscribe.
    for (let i = 0; i < 5; i++) {
      last().drop();
      feed.book(16);
      await jest.advanceTimersByTimeAsync(500 * 2 ** i);
      last().onopen?.();
      await settle();
    }
    expect(sockets).toHaveLength(6);
    expect(feed.status().requestsLastMin).toBe(3);
    expect(last().subscribes()).toHaveLength(0);

    // The held-back subscribe goes out once the window frees up.
    await jest.advanceTimersByTimeAsync(60_000);
    feed.book(16);
    expect(last().subscribes()).toHaveLength(1);

    const times = sockets.flatMap((s) => s.sentAt).sort((a, b) => a - b);
    for (const t of times) {
      expect(times.filter((u) => u > t - 60_000 && u <= t).length).toBeLessThanOrEqual(3);
    }
    feed.close();
  });

  it('closes after idleCloseMs without readers and reopens on the next read', async () => {
    const { feed, sockets, openAndAck } = setup({ idleCloseMs: 300_000 });
    feed.book(16);
    await openAndAck();

    jest.advanceTimersByTime(200_000);
    feed.book(16); // a read pushes the idle deadline out
    jest.advanceTimersByTime(299_999);
    expect(sockets[0].closed).toBe(false);
    jest.advanceTimersByTime(1);
    expect(sockets[0].closed).toBe(true);
    expect(feed.status().connected).toBe(false);

    // Closed for idleness it stays closed; the next read reopens it.
    jest.advanceTimersByTime(120_000);
    expect(sockets).toHaveLength(1);
    feed.book(16);
    expect(sockets).toHaveLength(2);
    feed.close();
  });

  it('counts and ignores unknown frames, and applies a registered delta handler', async () => {
    const applyDelta = jest.fn((current: PerplL2Book) => ({ ...current, bid: [] }));
    const { feed, last, openAndAck } = setup({ deltaHandlers: { 16: applyDelta } });
    feed.book(16);
    await openAndAck();
    last().emit(book(32));

    last().emit({ mt: 99, sid: 32 });
    last().emit({ mt: 99, sid: 32 });
    last().emit({ mt: 16, sid: 32 });
    expect(feed.status().ignoredFrames).toEqual({ 99: 2 });
    expect(applyDelta).toHaveBeenCalledTimes(1);
    expect(feed.book(32)?.book.bid).toEqual([]);
    feed.close();
  });

  it('folds mt:16 deltas into the book by default: replace by price, drop o:0 (SEN-62)', async () => {
    const { feed, last, openAndAck } = setup();
    feed.book(16);
    await openAndAck();
    last().emit(book(16, 100)); // bid 99, ask 101

    last().emit({
      mt: 16,
      sid: 16,
      sn: 2,
      at: { b: 2 },
      bid: [
        { p: 99, s: 0, o: 0 },
        { p: 98, s: 7, o: 2 },
      ],
      ask: [{ p: 101, s: 3, o: 1 }],
    });
    expect(feed.book(16)?.book).toMatchObject({
      at: { b: 2 },
      sn: 2,
      bid: [{ p: 98, s: 7, o: 2 }],
      ask: [{ p: 101, s: 3, o: 1 }],
    });
    expect(feed.status().ignoredFrames).toEqual({});
    feed.close();
  });

  it("keeps a quiet market's book fresh while its stream is live, not after a drop", async () => {
    const { feed, last, openAndAck } = setup({ staleMs: 15_000 });
    feed.book(16);
    await openAndAck();
    last().emit(book(16));
    last().emit(book(32));

    // Only market 32 moves; 16's book is unchanged but still current.
    for (let i = 0; i < 4; i++) {
      jest.advanceTimersByTime(10_000);
      last().emit({ mt: 16, sid: 32, at: { b: i }, bid: [], ask: [] });
    }
    expect(feed.book(16)?.stale).toBe(false);

    last().drop();
    expect(feed.book(16)?.stale).toBe(true);
    feed.close();
  });

  it('sends no pings unless asked to: they would spend the request budget (SEN-62)', async () => {
    const { feed, last, openAndAck } = setup();
    feed.book(16);
    await openAndAck();
    jest.advanceTimersByTime(120_000);
    expect(last().sent.filter((f) => f.mt === 1)).toEqual([]);
    feed.close();

    const pinging = setup({ pingIntervalMs: 30_000 });
    pinging.feed.book(16);
    await pinging.openAndAck();
    jest.advanceTimersByTime(60_000);
    expect(pinging.last().sent.filter((f) => f.mt === 1)).toHaveLength(2);
    pinging.feed.close();
  });

  it('asks for market ids on every connect', async () => {
    const { feed, last, marketIds, openAndAck } = setup();
    feed.book(16);
    await openAndAck();
    marketIds.mockResolvedValueOnce([16, 64]);
    last().drop();
    feed.book(16);
    jest.advanceTimersByTime(1_000);
    await openAndAck();

    expect(marketIds).toHaveBeenCalledTimes(2);
    expect(
      last()
        .subscribes()[0]
        .subs.map((s) => s.stream),
    ).toEqual(['order-book@16', 'order-book@64']);
    feed.close();
  });
});
