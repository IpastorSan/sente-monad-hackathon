/**
 * Perpl's side of the market-data service (SEN-75, plan B-T5b).
 *
 * Two sources, chosen so the phone and every agent run cost Perpl almost
 * nothing:
 *
 * | Perpl read                        | Source                              | TTL              |
 * | --------------------------------- | ----------------------------------- | ---------------- |
 * | catalog, mark/last/index/bid/ask  | `/pub/context` (ONE call, all mkts) | 3 s              |
 * | 24h open/high/low/volume          | 25 × 1h candles                     | 60 s             |
 * | klines                            | candles                             | 10/30/60 s       |
 * | depth, quote book                 | `PerplBookFeed` (held socket)       | live             |
 * | book fallback                     | `fetchBookSnapshot` (own socket)    | ≤1 per 30 s/mkt  |
 *
 * The book fallback is throttled because each one opens a socket against a
 * 10-requests/min server budget: when the feed has no fresh book and a snapshot
 * was taken in the last 30 s, the newest book we hold is served `stale: true`
 * rather than opening another — up to 60 s old, past which the book is refused.
 *
 * `funding` is still null, but needs no new request: every `/pub/context`
 * market carries its latest `funding` event and `funding_interval_sec`
 * (SEN-62, docs/perpl.md "Market data, probed"). Wiring it is a follow-up.
 */
import type { Logger } from '@nestjs/common';
import type { Decimal, Kline } from '@sente/venues';
import {
  bookToDepth,
  fromScaled,
  perplMarkets,
  perplSlippageBoundScaled,
  quoteFromBook,
  resolveSymbol,
  toScaled,
  type PerplContext,
  type PerplL2Book,
  type PerplL2Level,
  type PerplMarketData,
  type ResolvedMarket,
} from '@sente/venues/perpl';

import type {
  DepthDto,
  KlineInterval,
  KlinesDto,
  MarketDto,
  QuoteDto,
  TickerDto,
} from '../dto/markets.dto';
import {
  dayFields,
  dayStats,
  errorMessage,
  fillableWithin,
  IntervalNotSupportedError,
  InvalidSizeError,
  isMarketDataError,
  KLINE_WIDTH_MS,
  klineTtl,
  MarketNotFoundError,
  midOf,
  quoteCurrency,
  VenueUnavailableError,
  type DayStats,
  type PerplReader,
  type QuoteRequestDto,
} from '../market-data.service';
import { TtlCache, type CacheResult } from '../ttl-cache';
import type { PerplBookFeed } from './perpl-book-feed';

/** What the reader needs from `PerplMarketData`; specs fake it. */
export type PerplMarketSource = Pick<PerplMarketData, 'context' | 'getKlines'>;
/** What the reader needs from `PerplBookFeed`; specs fake it. */
export type PerplBookSource = Pick<PerplBookFeed, 'book'>;

export type PerplMarketReaderOptions = {
  readonly data: PerplMarketSource;
  readonly feed: PerplBookSource;
  /** A one-off snapshot on its own socket: `fetchBookSnapshot(wsUrl, id)` in production. */
  readonly snapshot: (marketId: number) => Promise<PerplL2Book>;
  readonly now?: () => number;
  readonly logger?: Pick<Logger, 'warn'>;
};

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

const TTL = {
  /** One REST call serves every market's prices, so it can be this short. */
  context: 3 * SECOND,
  day: 60 * SECOND,
  /** Minimum gap between fallback snapshots of one market. */
  snapshot: 30 * SECOND,
} as const;

const STALE_IF_ERROR = {
  context: 30 * SECOND,
  day: 5 * MINUTE,
  klines: 5 * MINUTE,
} as const;

/** Same threshold as the feed's own `staleMs`, so both sources call a book stale alike. */
const BOOK_STALE_MS = 15 * SECOND;

/**
 * The oldest book served at all once the feed has stopped vouching for it
 * (SEN-131). Two snapshot windows: one failed fallback is ridden out stale, a
 * second means Perpl's book is simply unknown. Without a cap the last book we
 * ever held was served (flagged stale) forever, which is the "old price shown
 * as current" the Kuru side refuses after 6.5 s. A quiet book on a live socket
 * is not capped: the feed calls it fresh however old its last frame (SEN-62).
 */
const BOOK_MAX_AGE_MS = 2 * TTL.snapshot;

type HeldBook = { readonly book: PerplL2Book; readonly receivedAt: number };
type ServedBook = HeldBook & { readonly stale: boolean };

export class PerplMarketReader implements PerplReader {
  readonly #data: PerplMarketSource;
  readonly #feed: PerplBookSource;
  readonly #snapshot: (marketId: number) => Promise<PerplL2Book>;
  readonly #now: () => number;
  readonly #logger?: Pick<Logger, 'warn'>;

  readonly #context = new TtlCache<'perpl', PerplContext>();
  readonly #day = new TtlCache<string, DayStats | null>();
  readonly #klines = new TtlCache<string, Kline[]>();
  /**
   * The value is the newest GOOD snapshot (or null), and the loader never
   * throws: a failed fetch must still count against the 30 s throttle, and
   * `TtlCache` does not remember failures.
   */
  readonly #snapshots = new TtlCache<number, HeldBook | null>();
  readonly #lastSnapshot = new Map<number, HeldBook>();
  readonly #snapshotError = new Map<number, string>();

  constructor(options: PerplMarketReaderOptions) {
    this.#data = options.data;
    this.#feed = options.feed;
    this.#snapshot = options.snapshot;
    this.#now = options.now ?? (() => Date.now());
    this.#logger = options.logger;
  }

  markets(): Promise<MarketDto[]> {
    return this.#perpl(async () => {
      const { value } = await this.#ctx();
      return perplMarkets(value).map((market) => ({
        venue: 'perpl',
        symbol: market.symbol,
        venueSymbol: market.venueSymbol ?? market.base,
        kind: 'perp',
        base: market.base,
        quote: quoteCurrency(market.quote),
        tickSize: market.tickSize,
        stepSize: market.stepSize,
        minSize: market.minSize,
        minNotional: null,
        maxLeverage: market.maxLeverage ?? null,
        marginMode: 'isolated',
        makerFee: market.makerFee ?? required('makerFee', market.symbol),
        takerFee: market.takerFee ?? required('takerFee', market.symbol),
      }));
    });
  }

  ticker(symbol: string): Promise<TickerDto> {
    return this.#perpl(async () => this.#ticker(await this.#ctx(), symbol));
  }

  /** Every open market's ticker off ONE context read; one bad market is dropped, not fatal. */
  tickers(): Promise<TickerDto[]> {
    return this.#perpl(async () => {
      const context = await this.#ctx();
      const symbols = perplMarkets(context.value).map((market) => market.symbol);
      const results = await Promise.allSettled(symbols.map((s) => this.#ticker(context, s)));
      const tickers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
      if (symbols.length > 0 && tickers.length === 0) {
        throw (results[0] as PromiseRejectedResult).reason;
      }
      return tickers;
    });
  }

  depth(symbol: string, limit: number): Promise<DepthDto> {
    return this.#perpl(async () => {
      const m = await this.#market(symbol);
      const { book, receivedAt, stale } = await this.#book(m);
      const depth = bookToDepth(book, m, limit);
      return {
        venue: 'perpl',
        symbol: m.symbol,
        bids: depth.bids,
        asks: depth.asks,
        sequence: depth.sequence ?? null,
        stale,
        asOf: receivedAt,
      };
    });
  }

  klines(
    symbol: string,
    interval: KlineInterval,
    limit: number,
    endTime?: number,
  ): Promise<KlinesDto> {
    return this.#perpl(async () => {
      // Perpl's longest candle is 1d; refuse before spending a context read.
      if (interval === '1w') throw new IntervalNotSupportedError('perpl', interval);
      const m = await this.#market(symbol);
      // Same bucketing as Kuru: `endTime` is exclusive and candles open on
      // boundaries, so rounding it up selects the same klines and shares a key.
      const width = KLINE_WIDTH_MS[interval];
      const end = endTime === undefined ? undefined : Math.ceil(endTime / width) * width;
      const { value, loadedAt } = await this.#klines.get(
        `${m.symbol}|${interval}|${limit}|${end ?? 'now'}`,
        klineTtl(interval),
        () => this.#data.getKlines({ symbol: m.symbol, interval, limit, endTime: end }),
        { staleIfErrorMs: STALE_IF_ERROR.klines },
      );
      return {
        venue: 'perpl',
        symbol: m.symbol,
        interval,
        klines: value.map((kline) => ({
          openTime: kline.openTime,
          closeTime: kline.closeTime,
          open: kline.open,
          high: kline.high,
          low: kline.low,
          close: kline.close,
          volume: kline.volume,
          quoteVolume: kline.quoteVolume ?? null,
        })),
        volumeIsEstimate: true,
        asOf: loadedAt,
      };
    });
  }

  quote(symbol: string, request: QuoteRequestDto): Promise<QuoteDto> {
    return this.#perpl(async () => {
      const m = await this.#market(symbol);
      const { side, size } = request;
      const wanted = scaledSize(size, m);
      const { book, receivedAt, stale } = await this.#book(m);
      const walked = quoteFromBook(book, m, { symbol: m.symbol, side, size });

      // Perpl bounds an immediate order off the MARK, not the book, and clamps
      // the slippage to the market's own maximum — so the bound and the
      // effective slippage come from the same helper `PerplVenue` places with.
      const mark = BigInt(m.raw.state.mrk);
      const bound = mark > 0n ? perplSlippageBoundScaled(mark, side, request.maxSlippage, m) : null;
      const levels = side === 'buy' ? book.ask : book.bid;
      const withinBound =
        bound === null ? 0n : fillableWithin(bookLevels(levels, side), side, bound.price, wanted);
      const filled = toScaled(walked.fillableSize, m.sd);

      return {
        venue: 'perpl',
        symbol: m.symbol,
        side,
        size,
        fillableSize: walked.fillableSize,
        averagePrice: filled > 0n ? walked.averagePrice : null,
        notional: walked.notional,
        estimatedFee: walked.estimatedFee ?? '0',
        feeAsset: quoteCurrency(m.collateral),
        slippageVsMid: walked.slippage,
        maxSlippage: bound === null ? request.maxSlippage : fromScaled(bound.micros, 6),
        worstPrice: bound === null ? null : fromScaled(bound.price, m.pd),
        fillableWithinWorstPrice: fromScaled(withinBound, m.sd),
        partial: withinBound < wanted,
        minNotionalOk: null,
        bookAsOf: receivedAt,
        stale,
      };
    });
  }

  mark(symbol: string): Promise<Decimal | null> {
    return this.#perpl(async () => {
      const m = await this.#market(symbol);
      return positive(m.raw.state.mrk, m.pd);
    });
  }

  // -------------------------------------------------------------------------

  /** Anything not already typed means Perpl is down, not that the request was wrong. */
  async #perpl<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (isMarketDataError(error)) throw error;
      throw new VenueUnavailableError('perpl', errorMessage(error));
    }
  }

  /**
   * Fronted by a TtlCache rather than relying on `PerplMarketData`'s own
   * cache alone, for single-flight AND stale-if-error: a context hiccup keeps
   * the tickers up (flagged stale) instead of blanking every Perpl price.
   */
  #ctx(): Promise<CacheResult<PerplContext>> {
    return this.#context.get('perpl', TTL.context, () => this.#data.context(TTL.context), {
      staleIfErrorMs: STALE_IF_ERROR.context,
    });
  }

  async #market(symbol: string): Promise<ResolvedMarket> {
    return resolveOrNotFound((await this.#ctx()).value, symbol);
  }

  async #ticker(context: CacheResult<PerplContext>, symbol: string): Promise<TickerDto> {
    const m = resolveOrNotFound(context.value, symbol);
    const state = m.raw.state;
    // Candles only enrich the ticker; without them the 24h fields are null.
    const day = await this.#dayStats(m).catch(() => undefined);
    const last = positive(state.lst, m.pd);
    const bid = positive(state.bid, m.pd);
    const ask = positive(state.ask, m.pd);
    return {
      venue: 'perpl',
      symbol: m.symbol,
      quote: quoteCurrency(m.collateral),
      last,
      mark: positive(state.mrk, m.pd),
      // `orl` is Perpl's live oracle price. Funding's own `idx` is set from it
      // once per interval: at the moment a rate was set, all 9 markets' `idx` sat
      // within 0.06% of `orl` (SEN-62), so `orl` is the index a ticker should show.
      index: positive(state.orl, m.pd),
      bid,
      ask,
      mid: positive(state.mid, m.pd) ?? midOf(bid, ask),
      ...dayFields(last, day?.value ?? null),
      funding: null,
      stale: context.stale || Boolean(day?.stale),
      asOf: Math.min(state.at.t ?? context.loadedAt, day?.loadedAt ?? Infinity),
    };
  }

  /** The rolling 24h window from 25 hourly candles, as on Kuru. */
  #dayStats(m: ResolvedMarket): Promise<CacheResult<DayStats | null>> {
    return this.#day.get(
      m.symbol,
      TTL.day,
      async () => {
        const klines = await this.#data.getKlines({ symbol: m.symbol, interval: '1h', limit: 25 });
        const since = this.#now() - DAY;
        return dayStats(klines.filter((kline) => kline.closeTime >= since));
      },
      { staleIfErrorMs: STALE_IF_ERROR.day },
    );
  }

  /**
   * The feed's book when fresh; else a fallback snapshot if none was taken in
   * the last 30 s; else the newest book we hold, flagged stale.
   */
  async #book(m: ResolvedMarket): Promise<ServedBook> {
    const id = m.raw.id;
    const fed = this.#feed.book(id);
    if (fed && !fed.stale) return fed;

    const { value: snapshot } = await this.#snapshots.get(id, TTL.snapshot, async () => {
      try {
        const held = { book: await this.#snapshot(id), receivedAt: this.#now() };
        this.#lastSnapshot.set(id, held);
        this.#snapshotError.delete(id);
        return held;
      } catch (error) {
        this.#snapshotError.set(id, errorMessage(error));
        this.#logger?.warn(`Perpl book snapshot for ${m.symbol} failed: ${errorMessage(error)}`);
        return this.#lastSnapshot.get(id) ?? null;
      }
    });

    const newest = [fed, snapshot]
      .filter((held): held is HeldBook => held !== null && held !== undefined)
      .sort((a, b) => b.receivedAt - a.receivedAt)[0];
    const age = newest ? this.#now() - newest.receivedAt : Infinity;
    if (!newest || age >= BOOK_MAX_AGE_MS) {
      const why = this.#snapshotError.get(id) ?? 'no book received yet';
      const which = newest ? `order book newer than ${BOOK_MAX_AGE_MS / SECOND} s` : 'order book';
      throw new VenueUnavailableError('perpl', `no ${m.symbol} ${which}: ${why}`);
    }
    return { book: newest.book, receivedAt: newest.receivedAt, stale: age > BOOK_STALE_MS };
  }
}

// ---------------------------------------------------------------------------

function resolveOrNotFound(context: PerplContext, symbol: string): ResolvedMarket {
  try {
    return resolveSymbol(context, symbol);
  } catch {
    // Closed markets too: a market nobody can trade is not one we list.
    throw new MarketNotFoundError('perpl', symbol);
  }
}

/** Perpl reports an absent price as 0; the wire contract says null. */
function positive(scaled: number, decimals: number): Decimal | null {
  return scaled > 0 ? fromScaled(scaled, decimals) : null;
}

function scaledSize(size: Decimal, m: ResolvedMarket): bigint {
  let wanted: bigint;
  try {
    wanted = toScaled(size, m.sd);
  } catch (error) {
    // `PrecisionError` (finer than the step) or not a decimal at all.
    throw new InvalidSizeError(`${m.symbol} size: ${errorMessage(error)}`);
  }
  if (wanted <= 0n) throw new InvalidSizeError('size must be greater than zero');
  return wanted;
}

/** Non-empty levels, best first, in the bigint shape `fillableWithin` walks. */
function bookLevels(levels: readonly PerplL2Level[], side: 'buy' | 'sell') {
  return levels
    .filter((level) => level.s > 0)
    .sort((a, b) => (side === 'buy' ? a.p - b.p : b.p - a.p))
    .map((level) => ({ price: BigInt(level.p), size: BigInt(level.s) }));
}

/** Absent fees mean unknown, not free; never publish them as zero. */
function required(field: string, symbol: string): never {
  throw new Error(`${symbol} ${field} is missing from the Perpl context`);
}
