/**
 * PerplBookFeed: the one market-data socket the API holds (SEN-64, plan B-T4).
 *
 * Perpl publishes order books only on its market-data socket, and the server
 * allows 10 requests/min per connection. `fetchBookSnapshot` opens a fresh
 * socket per read, so every phone and every agent run asking for depth used to
 * cost a connection and a subscribe. This feed holds ONE connection with ONE
 * batched subscribe for every market and serves the latest book from memory.
 *
 * - **Lazy + idle close.** Nothing connects until the first read, and the
 *   socket closes after `idleCloseMs` without readers, so an API nobody is
 *   looking at holds no connection.
 * - **Request budget.** Every frame we send (subscribe, refresh, ping) goes
 *   through one sliding-window counter capped below the server's 10/min. The
 *   counter lives on the feed, not the connection: a reconnect storm must not
 *   buy a fresh allowance, since we cannot tell whether Perpl counts per
 *   connection or per client IP.
 * - **Reconnect** with exponential backoff and jitter, capped at 60 s.
 * - **Snapshot, then deltas** (probed in SEN-62, docs/perpl.md). Perpl sends
 *   one `mt:15` snapshot per subscribe and then only `mt:16` updates carrying
 *   the changed levels, which `applyL2BookUpdate` folds in by default. Other
 *   `mt` values go to pluggable `deltaHandlers`, else are counted and ignored.
 * - **Freshness is the stream's, not the book's.** A quiet market sends no
 *   `mt:16` for minutes, yet its book is current while the socket is live. So
 *   a subscribed book counts as fresh as the socket's last frame; only a book
 *   whose stream went quiet ages into `stale`, and a read of one re-subscribes
 *   that market (at most every `refreshMinMs`, within the budget) for a fresh
 *   snapshot.
 */
import type { Logger } from '@nestjs/common';
import {
  applyL2BookUpdate,
  defaultWebSocket,
  MT,
  type PerplL2Book,
  type WebSocketFactory,
  type WebSocketLike,
} from '@sente/venues/perpl';

/** A frame off the market-data socket, before we know what it is. */
export type PerplMarketFrame = {
  readonly mt: number;
  readonly sid?: number;
  readonly [key: string]: unknown;
};

/**
 * Applies one non-snapshot frame to a market's current book and returns the
 * new book (or `undefined` to leave it unchanged). Registered per `mt`;
 * `mt:16` has a default (`DEFAULT_DELTA_HANDLERS`).
 */
export type PerplBookDeltaHandler = (
  current: PerplL2Book,
  frame: PerplMarketFrame,
) => PerplL2Book | undefined;

export type PerplBookEntry = {
  readonly book: PerplL2Book;
  /** Epoch ms the frame that produced this book arrived. */
  readonly receivedAt: number;
  /**
   * No frame for this book in `staleMs` — neither its own, nor, while its
   * stream is subscribed, any frame on the socket: the caller should fall
   * back or say so.
   */
  readonly stale: boolean;
};

/** `mt:16` is a delta of changed levels, `o: 0` removing one (SEN-62). */
export const DEFAULT_DELTA_HANDLERS: Readonly<Record<number, PerplBookDeltaHandler>> = {
  [MT.L2BookUpdate]: (current, frame) =>
    applyL2BookUpdate(current, frame as unknown as PerplL2Book),
};

export type PerplBookFeedStatus = {
  readonly connected: boolean;
  /** Markets with a book in memory. */
  readonly markets: number[];
  readonly lastFrameAt: number | null;
  readonly reconnects: number;
  readonly requestsLastMin: number;
  /** Frames with an `mt` we have no handler for, by `mt`: a new frame kind shows up here first. */
  readonly ignoredFrames: Readonly<Record<number, number>>;
  /** Per-subscription refusals from the last `mt:6`, by market id. */
  readonly subscriptionErrors: Readonly<Record<number, string>>;
};

export type PerplBookFeedOptions = {
  /** Base URL, e.g. `wss://testnet.perpl.xyz`; `/ws/v1/market-data` is appended. */
  readonly wsUrl: string;
  /** Asked on every (re)connect, so markets opened since are picked up. */
  readonly marketIds: () => Promise<number[]>;
  readonly webSocket?: WebSocketFactory;
  readonly idleCloseMs?: number;
  readonly staleMs?: number;
  /** Below the server's 10/min so a miscount on our side still stays under it. */
  readonly maxRequestsPerMin?: number;
  /**
   * Off (0) by default: a market-data socket that sent nothing for 23 min was
   * never idled out (SEN-62), and each ping costs one of the 10 requests/min.
   */
  readonly pingIntervalMs?: number;
  /** Minimum gap between re-subscribes of a stale market. */
  readonly refreshMinMs?: number;
  readonly deltaHandlers?: Readonly<Record<number, PerplBookDeltaHandler>>;
  readonly now?: () => number;
  /** In [0, 1); injectable so backoff is deterministic in specs. */
  readonly random?: () => number;
  readonly logger?: Pick<Logger, 'log' | 'warn'>;
};

const MARKET_DATA_PATH = '/ws/v1/market-data';
const WINDOW_MS = 60_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_CAP_MS = 60_000;
const streamOf = (marketId: number) => `order-book@${marketId}`;
const marketOf = (stream: string): number | undefined => {
  const match = /^order-book@(\d+)$/.exec(stream);
  return match ? Number(match[1]) : undefined;
};

type Waiter = {
  readonly resolve: (entry: PerplBookEntry) => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
};

type SubscriptionResponse = {
  subs?: { stream: string; sid?: number; status?: { code: number; error?: string } }[];
};

export class PerplBookFeed {
  private readonly url: string;
  private readonly marketIds: () => Promise<number[]>;
  private readonly webSocket: WebSocketFactory;
  private readonly idleCloseMs: number;
  private readonly staleMs: number;
  private readonly maxRequestsPerMin: number;
  private readonly pingIntervalMs: number;
  private readonly refreshMinMs: number;
  private readonly deltaHandlers: Readonly<Record<number, PerplBookDeltaHandler>>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly logger?: Pick<Logger, 'log' | 'warn'>;

  private ws: WebSocketLike | null = null;
  private open = false;
  private shutDown = false;
  private lastReadAt = 0;
  private lastFrameAt: number | null = null;
  private reconnects = 0;
  private attempt = 0;
  /** Send times inside the last minute, oldest first. */
  private sent: number[] = [];
  /** Markets still waiting for the budget to subscribe them on this connection. */
  private pendingSubscribe: number[] = [];

  private readonly books = new Map<number, { book: PerplL2Book; receivedAt: number }>();
  private readonly sidToMarket = new Map<number, number>();
  private readonly lastRefreshAt = new Map<number, number>();
  private readonly subscriptionErrors: Record<number, string> = {};
  private readonly ignoredFrames: Record<number, number> = {};
  private readonly waiters = new Map<number, Set<Waiter>>();

  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private budgetTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;

  constructor(o: PerplBookFeedOptions) {
    this.url = `${o.wsUrl}${MARKET_DATA_PATH}`;
    this.marketIds = o.marketIds;
    this.webSocket = o.webSocket ?? defaultWebSocket;
    this.idleCloseMs = o.idleCloseMs ?? 300_000;
    this.staleMs = o.staleMs ?? 15_000;
    this.maxRequestsPerMin = o.maxRequestsPerMin ?? 8;
    this.pingIntervalMs = o.pingIntervalMs ?? 0;
    this.refreshMinMs = o.refreshMinMs ?? 10_000;
    this.deltaHandlers = { ...DEFAULT_DELTA_HANDLERS, ...o.deltaHandlers };
    this.now = o.now ?? Date.now;
    this.random = o.random ?? Math.random;
    this.logger = o.logger;
  }

  /**
   * The latest book for a market, or `undefined` if none has arrived yet. A
   * read is what keeps the socket alive: the first one opens it.
   */
  book(marketId: number): PerplBookEntry | undefined {
    if (this.shutDown) return undefined;
    this.touch();
    const entry = this.entry(marketId);
    if (entry?.stale) this.refresh(marketId);
    return entry;
  }

  /** Like `book`, but waits up to `timeoutMs` for the first fresh snapshot. */
  waitFor(marketId: number, timeoutMs: number): Promise<PerplBookEntry> {
    const current = this.book(marketId);
    if (current && !current.stale) return Promise.resolve(current);
    if (this.shutDown) return Promise.reject(new Error('Perpl book feed is closed'));
    const refused = this.subscriptionErrors[marketId];
    if (refused) return Promise.reject(new Error(`${streamOf(marketId)}: ${refused}`));

    return new Promise((resolve, reject) => {
      const set = this.waiters.get(marketId) ?? new Set<Waiter>();
      this.waiters.set(marketId, set);
      const waiter: Waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          set.delete(waiter);
          reject(new Error(`no ${streamOf(marketId)} snapshot within ${timeoutMs}ms`));
        }, timeoutMs),
      };
      set.add(waiter);
    });
  }

  status(): PerplBookFeedStatus {
    return {
      connected: this.open,
      markets: [...this.books.keys()].sort((a, b) => a - b),
      lastFrameAt: this.lastFrameAt,
      reconnects: this.reconnects,
      requestsLastMin: this.requestsInWindow(),
      ignoredFrames: { ...this.ignoredFrames },
      subscriptionErrors: { ...this.subscriptionErrors },
    };
  }

  /** Terminal: for `onModuleDestroy`. Later reads return nothing. */
  close(): void {
    this.shutDown = true;
    clearTimeout(this.idleTimer);
    clearTimeout(this.reconnectTimer);
    this.disconnect();
    this.rejectWaiters(() => true, new Error('Perpl book feed is closed'));
  }

  // -------------------------------------------------------------------------
  // Connection lifetime

  private touch(): void {
    this.lastReadAt = this.now();
    if (!this.ws && !this.reconnectTimer) this.connect();
    if (!this.idleTimer) this.armIdle(this.idleCloseMs);
  }

  private armIdle(delayMs: number): void {
    this.idleTimer = setTimeout(() => {
      this.idleTimer = undefined;
      const idleFor = this.now() - this.lastReadAt;
      if (idleFor < this.idleCloseMs) {
        this.armIdle(this.idleCloseMs - idleFor);
        return;
      }
      this.logger?.log(`Perpl book feed idle for ${idleFor}ms; closing`);
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
      this.attempt = 0;
      this.disconnect();
    }, delayMs);
  }

  private connect(): void {
    const ws = this.webSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.open = true;
      if (this.pingIntervalMs > 0) {
        this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
      }
      void this.subscribeAll(ws);
    };
    ws.onmessage = (event) => {
      if (this.ws === ws) this.onFrame(event.data);
    };
    ws.onerror = () => undefined; // `onclose` follows and carries the code
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.logger?.warn(`Perpl book feed socket closed (${event.code} ${event.reason})`.trim());
      this.disconnect();
      this.scheduleReconnect();
    };
  }

  /** Drops the socket and everything tied to it; keeps books (they age into `stale`). */
  private disconnect(): void {
    const ws = this.ws;
    this.ws = null;
    this.open = false;
    clearInterval(this.pingTimer);
    clearTimeout(this.budgetTimer);
    this.budgetTimer = undefined;
    this.pendingSubscribe = [];
    // sids are per connection.
    this.sidToMarket.clear();
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = null;
      ws.close(1000);
    }
  }

  private scheduleReconnect(): void {
    if (this.shutDown || this.now() - this.lastReadAt >= this.idleCloseMs) return;
    // Full-ish jitter in [0.5, 1) of the exponential step, so a Perpl restart
    // does not have every replica reconnect in the same second.
    const step = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** this.attempt);
    const delay = Math.min(BACKOFF_CAP_MS, Math.round(step * (0.5 + this.random() / 2)));
    this.attempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.shutDown || this.ws) return;
      this.reconnects += 1;
      this.connect();
    }, delay);
  }

  private async subscribeAll(ws: WebSocketLike): Promise<void> {
    let ids: number[];
    try {
      ids = await this.marketIds();
    } catch (error) {
      if (this.ws !== ws) return;
      this.logger?.warn(`Perpl book feed: market ids unavailable: ${String(error)}`);
      this.disconnect();
      this.scheduleReconnect();
      return;
    }
    if (this.ws !== ws) return;
    this.pendingSubscribe = [...new Set(ids)];
    this.flushSubscribe();
  }

  /** One batched subscribe for everything pending, as soon as the budget allows. */
  private flushSubscribe(): void {
    if (!this.ws || !this.open || this.pendingSubscribe.length === 0) return;
    const ids = this.pendingSubscribe;
    const frame = {
      mt: MT.SubscriptionRequest,
      subs: ids.map((id) => ({ stream: streamOf(id), subscribe: true })),
    };
    if (this.send(frame)) {
      this.pendingSubscribe = [];
      return;
    }
    if (!this.budgetTimer) {
      this.budgetTimer = setTimeout(() => {
        this.budgetTimer = undefined;
        this.flushSubscribe();
      }, this.budgetFreesInMs());
    }
  }

  /**
   * Asks again for a stale market's snapshot. Unsubscribe + subscribe in ONE
   * frame: a bare re-subscribe of a held stream is acked with no new `mt:15`,
   * while the pair brings one and keeps the sid (both probed in SEN-62).
   */
  private refresh(marketId: number): void {
    if (!this.open) return;
    const last = this.lastRefreshAt.get(marketId) ?? -Infinity;
    if (this.now() - last < this.refreshMinMs) return;
    if (this.pendingSubscribe.includes(marketId)) return;
    this.lastRefreshAt.set(marketId, this.now());
    this.send({
      mt: MT.SubscriptionRequest,
      subs: [
        { stream: streamOf(marketId), subscribe: false },
        { stream: streamOf(marketId), subscribe: true },
      ],
    });
  }

  private ping(): void {
    // A skipped ping only risks an idle drop, which reconnect handles; a
    // request over budget risks the whole connection.
    this.send({ mt: MT.Ping, t: this.now() });
  }

  // -------------------------------------------------------------------------
  // Request budget

  private send(frame: object): boolean {
    if (!this.ws || this.requestsInWindow() >= this.maxRequestsPerMin) return false;
    this.sent.push(this.now());
    this.ws.send(JSON.stringify(frame));
    return true;
  }

  private requestsInWindow(): number {
    const cutoff = this.now() - WINDOW_MS;
    while (this.sent.length > 0 && this.sent[0] <= cutoff) this.sent.shift();
    return this.sent.length;
  }

  private budgetFreesInMs(): number {
    return Math.max(1, this.sent[0] + WINDOW_MS - this.now() + 1);
  }

  // -------------------------------------------------------------------------
  // Frames

  private onFrame(data: unknown): void {
    let frame: PerplMarketFrame;
    try {
      frame = JSON.parse(String(data)) as PerplMarketFrame;
    } catch {
      this.logger?.warn('Perpl book feed: unparseable frame');
      return;
    }
    this.lastFrameAt = this.now();

    switch (frame.mt) {
      case MT.SubscriptionResponse:
        this.onSubscription(frame as SubscriptionResponse);
        return;
      case MT.L2BookSnapshot:
        this.onSnapshot(frame as unknown as PerplL2Book);
        return;
      case MT.StatusResponse: {
        const status = frame.status as { code?: number; error?: string } | undefined;
        if (status?.code) {
          this.logger?.warn(`Perpl book feed status ${status.code} ${status.error ?? ''}`.trim());
        }
        return;
      }
      case MT.Heartbeat:
        return;
    }

    const handler = this.deltaHandlers[frame.mt];
    const marketId = frame.sid === undefined ? undefined : this.sidToMarket.get(frame.sid);
    const current = marketId === undefined ? undefined : this.books.get(marketId);
    if (!handler || marketId === undefined || !current) {
      this.ignoredFrames[frame.mt] = (this.ignoredFrames[frame.mt] ?? 0) + 1;
      return;
    }
    const next = handler(current.book, frame);
    if (next) this.store(marketId, next);
  }

  private onSubscription(frame: SubscriptionResponse): void {
    for (const sub of frame.subs ?? []) {
      const marketId = marketOf(sub.stream);
      if (marketId === undefined) continue;
      // Failures are per subscription: the socket stays up for the others.
      if (sub.status && sub.status.code !== 0) {
        const reason = `${sub.status.code} ${sub.status.error ?? ''}`.trim();
        this.subscriptionErrors[marketId] = reason;
        this.logger?.warn(`Perpl book feed: ${sub.stream} refused: ${reason}`);
        this.rejectWaiters((id) => id === marketId, new Error(`${sub.stream}: ${reason}`));
        continue;
      }
      delete this.subscriptionErrors[marketId];
      if (sub.sid !== undefined) this.sidToMarket.set(sub.sid, marketId);
    }
  }

  private onSnapshot(book: PerplL2Book): void {
    const marketId = this.sidToMarket.get(book.sid);
    if (marketId === undefined) {
      this.ignoredFrames[book.mt] = (this.ignoredFrames[book.mt] ?? 0) + 1;
      return;
    }
    this.attempt = 0; // a working stream is what proves the connection healthy
    this.store(marketId, book);
  }

  private store(marketId: number, book: PerplL2Book): void {
    this.books.set(marketId, { book, receivedAt: this.now() });
    const entry = this.entry(marketId);
    const waiting = this.waiters.get(marketId);
    if (!entry || !waiting) return;
    this.waiters.delete(marketId);
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.resolve(entry);
    }
  }

  private entry(marketId: number): PerplBookEntry | undefined {
    const held = this.books.get(marketId);
    if (!held) return undefined;
    // Deltas only arrive on change, so a live subscription vouches for a quiet
    // book: any recent frame on the socket proves the stream is still flowing.
    const live = this.open && [...this.sidToMarket.values()].includes(marketId);
    const heardAt = live ? Math.max(held.receivedAt, this.lastFrameAt ?? 0) : held.receivedAt;
    return { ...held, stale: this.now() - heardAt > this.staleMs };
  }

  private rejectWaiters(match: (marketId: number) => boolean, error: Error): void {
    for (const [marketId, set] of this.waiters) {
      if (!match(marketId)) continue;
      this.waiters.delete(marketId);
      for (const w of set) {
        clearTimeout(w.timer);
        w.reject(error);
      }
    }
  }
}
