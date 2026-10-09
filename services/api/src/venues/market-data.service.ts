/**
 * Market data for the phone and the agents, from one cached read path
 * (SEN-70, plan B-T5a; the Perpl side is B-T5b).
 *
 * Every `/markets` route and — from B-T11 — every agent tool reads through
 * here, so a venue sees one request per cache window however many screens and
 * agents are watching. Each read has its own TTL, sized to how fast the thing
 * actually changes and how expensive it is to ask:
 *
 * | Kuru read                         | Source                     | TTL             |
 * | --------------------------------- | -------------------------- | --------------- |
 * | catalog                           | Data Source                | 60 s            |
 * | depth, bid/ask                    | Gateway `depth(sym, 50)`   | 2 s per symbol  |
 * | `last` (latest 1m close)          | Data Source candles        | 10 s            |
 * | 24h open/high/low/volume          | 25 × 1h candles            | 60 s            |
 * | klines                            | Data Source candles        | 10/30/60 s      |
 * | quote book                        | chain `getL2Book` snapshot | 1.5 s per market|
 *
 * Perpl's reads and TTLs live in `PerplMarketReader` (SEN-75): one 3 s
 * `/pub/context` for every price, the held book socket for depth and quotes.
 *
 * The quote reads the CHAIN, not the Gateway, because its `worstPrice` is what
 * the app passes as `slippageLimitPrice` when it places — it has to be the
 * same book the order will meet (SEN-63).
 *
 * Money stays a decimal string end to end; arithmetic goes through bigint.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Decimal, Depth, DepthQuery, Kline, KlineQuery, Market, Side } from '@sente/venues';
import {
  fromUnits,
  KuruCatalogError,
  KuruUnitsError,
  kuruSlippageBound,
  precisionDecimals,
  ratioToDecimal,
  simulateQuote,
  toUnits,
  type BookLevel,
  type KuruBookSnapshot,
  type KuruMarketConfig,
} from '@sente/venues/kuru';

import type {
  DepthDto,
  KlineInterval,
  KlinesDto,
  MarketDto,
  MarketsResponseDto,
  QuoteCurrency,
  QuoteDto,
  TickerDto,
  TickersResponseDto,
  VenueId,
} from './dto/markets.dto';
import { TtlCache, type CacheResult } from './ttl-cache';

// ---------------------------------------------------------------------------
// Readers

/**
 * The Kuru reads this service needs. A read-only `KuruVenue({ publicClient })`
 * — no `account`, no submitter — satisfies it structurally; specs fake it.
 */
export interface KuruReader {
  /** Local config lookup; throws for a symbol Kuru does not list. No network. */
  market(symbol: string): KuruMarketConfig;
  /** Data Source catalog: the pinned markets it lists, and the pinned ones it does not. */
  listedMarkets(): Promise<{ markets: Market[]; missing: readonly string[] }>;
  /** Gateway aggregated book. */
  getDepth(query: DepthQuery): Promise<Depth>;
  /** Data Source candles. */
  getKlines(query: KlineQuery): Promise<Kline[]>;
  /** Live on-chain book plus market params. */
  bookSnapshot(symbol: string): Promise<KuruBookSnapshot>;
}

/**
 * Perpl's side, already in wire shapes. `PerplMarketReader`
 * (`perpl/perpl-market-reader.ts`, SEN-75) implements it over `PerplMarketData`
 * and `PerplBookFeed`, with its own caching; this service only merges and
 * dispatches. Every method throws
 * `MarketNotFoundError`, `IntervalNotSupportedError` or `VenueUnavailableError`
 * for the cases those name.
 */
export interface PerplReader {
  markets(): Promise<MarketDto[]>;
  ticker(symbol: string): Promise<TickerDto>;
  tickers(): Promise<TickerDto[]>;
  depth(symbol: string, limit: number): Promise<DepthDto>;
  klines(
    symbol: string,
    interval: KlineInterval,
    limit: number,
    endTime?: number,
  ): Promise<KlinesDto>;
  quote(symbol: string, request: QuoteRequestDto): Promise<QuoteDto>;
  mark(symbol: string): Promise<Decimal | null>;
}

/**
 * A Perpl that reports itself down rather than empty, so `/markets` says
 * `{ venue: 'perpl', ok: false }` instead of pretending Perpl lists nothing.
 * `VenuesModule` wires the real reader (SEN-75); this one is for specs that
 * only exercise the Kuru side.
 */
export class UnavailablePerplReader implements PerplReader {
  #down(): Promise<never> {
    return Promise.reject(new VenueUnavailableError('perpl', 'the Perpl reader is not wired yet'));
  }
  markets = () => this.#down();
  ticker = () => this.#down();
  tickers = () => this.#down();
  depth = () => this.#down();
  klines = () => this.#down();
  quote = () => this.#down();
  mark = () => this.#down();
}

export const KURU_READER = Symbol('KURU_READER');
export const PERPL_READER = Symbol('PERPL_READER');

export type QuoteRequestDto = {
  readonly side: Side;
  /** Base units. */
  readonly size: Decimal;
  /** Fraction, e.g. `'0.005'`. */
  readonly maxSlippage: Decimal;
};

// ---------------------------------------------------------------------------
// Errors — plain `Error`s; B-T6's controller maps `reason` to a status.

export class MarketNotFoundError extends Error {
  readonly reason = 'market_not_found' as const;
  constructor(
    readonly venue: VenueId,
    readonly symbol: string,
  ) {
    super(`${venue} does not list ${symbol}`);
    this.name = 'MarketNotFoundError';
  }
}

export class IntervalNotSupportedError extends Error {
  readonly reason = 'interval_not_supported' as const;
  constructor(
    readonly venue: VenueId,
    readonly interval: string,
  ) {
    super(`${venue} has no ${interval} klines`);
    this.name = 'IntervalNotSupportedError';
  }
}

/** A size the venue cannot represent: zero, negative, or finer than its step. */
export class InvalidSizeError extends Error {
  readonly reason = 'invalid_size' as const;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSizeError';
  }
}

export class VenueUnavailableError extends Error {
  readonly reason = 'venue_unavailable' as const;
  constructor(
    readonly venue: VenueId,
    detail: string,
    readonly retryAfterMs = DEFAULT_RETRY_AFTER_MS,
  ) {
    super(`${venue} is unavailable: ${detail}`);
    this.name = 'VenueUnavailableError';
  }
}

export type MarketDataError =
  MarketNotFoundError | IntervalNotSupportedError | InvalidSizeError | VenueUnavailableError;

export function isMarketDataError(error: unknown): error is MarketDataError {
  return (
    error instanceof MarketNotFoundError ||
    error instanceof IntervalNotSupportedError ||
    error instanceof InvalidSizeError ||
    error instanceof VenueUnavailableError
  );
}

// ---------------------------------------------------------------------------

const DEFAULT_RETRY_AFTER_MS = 5_000;
const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Gateway levels fetched per symbol; `depth(limit)` slices this one read. */
const DEPTH_LEVELS = 50;
const MAX_KLINES = 1000;

const TTL = {
  markets: 60 * SECOND,
  depth: 2 * SECOND,
  last: 10 * SECOND,
  day: 60 * SECOND,
  book: 1_500,
} as const;

/**
 * How long past expiry a value may stand in for a failed reload. Short for the
 * book a quote is priced on — that one is about to be signed against.
 */
const STALE_IF_ERROR = {
  markets: 10 * MINUTE,
  depth: 10 * SECOND,
  last: MINUTE,
  day: 5 * MINUTE,
  klines: 5 * MINUTE,
  book: 5 * SECOND,
} as const;

export const KLINE_WIDTH_MS: Record<KlineInterval, number> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': HOUR,
  '4h': 4 * HOUR,
  '1d': DAY,
  '1w': 7 * DAY,
};

export function klineTtl(interval: KlineInterval): number {
  if (interval === '1m') return 10 * SECOND;
  if (interval === '5m') return 30 * SECOND;
  return 60 * SECOND;
}

/** Every decimal is compared and combined at 18 places — more than any venue price carries. */
const SCALE = 18;
const x18 = (value: Decimal): bigint => toUnits(value, SCALE);
const fromX18 = (value: bigint): Decimal => fromUnits(value, SCALE);

export type DayStats = {
  open: Decimal;
  high: Decimal;
  low: Decimal;
  quoteVolume: Decimal | null;
  /** Close of the newest candle in the window, used when no 1m close exists. */
  close: Decimal;
};

@Injectable()
export class MarketDataService {
  readonly #markets = new TtlCache<'kuru', { markets: Market[]; missing: string[] }>();
  readonly #logger = new Logger(MarketDataService.name);
  readonly #depth = new TtlCache<string, Depth>();
  readonly #last = new TtlCache<string, Decimal | null>();
  readonly #day = new TtlCache<string, DayStats | null>();
  readonly #klines = new TtlCache<string, Kline[]>();
  readonly #book = new TtlCache<string, KuruBookSnapshot>();

  constructor(
    @Inject(KURU_READER) private readonly kuru: KuruReader,
    @Inject(PERPL_READER) private readonly perpl: PerplReader,
  ) {}

  /**
   * Both catalogs, merged. A venue that fails is reported in `venues`, not
   * thrown. So is a Kuru market this build pins that Kuru's catalog no longer
   * lists (SEN-185): `ok: false`, `missing` naming it, and whatever IS listed
   * still served.
   */
  async markets(): Promise<MarketsResponseDto> {
    const [kuru, perpl] = await Promise.allSettled([this.#kuruCatalog(), this.perpl.markets()]);
    const markets: MarketDto[] = [];
    const venues: MarketsResponseDto['venues'] = [];
    if (kuru.status === 'fulfilled') {
      const { markets: listed, missing } = kuru.value;
      markets.push(...listed);
      venues.push(
        missing.length === 0
          ? { venue: 'kuru', ok: true }
          : {
              venue: 'kuru',
              ok: false,
              error: new KuruCatalogError(missing).message,
              missing,
            },
      );
    } else {
      venues.push({ venue: 'kuru', ok: false, error: errorMessage(kuru.reason) });
    }
    if (perpl.status === 'fulfilled') {
      markets.push(...perpl.value);
      venues.push({ venue: 'perpl', ok: true });
    } else {
      venues.push({ venue: 'perpl', ok: false, error: errorMessage(perpl.reason) });
    }
    return { markets, venues, asOf: Date.now() };
  }

  async market(venue: VenueId, symbol: string): Promise<MarketDto> {
    const markets = venue === 'kuru' ? await this.#kuruMarkets() : await this.perpl.markets();
    const market = markets.find((candidate) => candidate.symbol === symbol);
    if (!market) throw new MarketNotFoundError(venue, symbol);
    return market;
  }

  ticker(venue: VenueId, symbol: string): Promise<TickerDto> {
    if (venue === 'perpl') return this.perpl.ticker(symbol);
    return this.#kuruTicker(symbol);
  }

  /**
   * Every listed market's ticker. With no `venue`, a venue that is down is
   * left out rather than failing the whole list; asked for by name, it throws.
   */
  async tickers(venue?: VenueId): Promise<TickersResponseDto> {
    const venues: VenueId[] = venue ? [venue] : ['kuru', 'perpl'];
    const results = await Promise.allSettled(venues.map((id) => this.#venueTickers(id)));
    const tickers: TickerDto[] = [];
    results.forEach((result) => {
      if (result.status === 'fulfilled') tickers.push(...result.value);
      else if (venue) throw result.reason;
    });
    return { tickers, asOf: Date.now() };
  }

  depth(venue: VenueId, symbol: string, limit: number): Promise<DepthDto> {
    const levels = clamp(limit, 1, DEPTH_LEVELS);
    if (venue === 'perpl') return this.perpl.depth(symbol, levels);
    return this.#kuru(async () => {
      const market = this.#kuruMarket(symbol);
      const { value, stale, loadedAt } = await this.#kuruDepth(market);
      return {
        venue: 'kuru',
        symbol: market.symbol,
        bids: value.bids.slice(0, levels),
        asks: value.asks.slice(0, levels),
        sequence: value.sequence ?? null,
        stale,
        asOf: loadedAt,
      };
    });
  }

  klines(
    venue: VenueId,
    symbol: string,
    interval: KlineInterval,
    limit: number,
    endTime?: number,
  ): Promise<KlinesDto> {
    if (!(interval in KLINE_WIDTH_MS)) {
      return Promise.reject(new IntervalNotSupportedError(venue, interval));
    }
    const count = clamp(limit, 1, MAX_KLINES);
    if (venue === 'perpl') return this.perpl.klines(symbol, interval, count, endTime);
    return this.#kuru(async () => {
      const market = this.#kuruMarket(symbol);
      // Candles open on interval boundaries and `endTime` is exclusive, so
      // rounding it UP to a boundary selects exactly the same klines — and
      // lets every caller inside one interval share a cache entry.
      const width = KLINE_WIDTH_MS[interval];
      const end = endTime === undefined ? undefined : Math.ceil(endTime / width) * width;
      const { value, loadedAt } = await this.#klines.get(
        `${market.symbol}|${interval}|${count}|${end ?? 'now'}`,
        klineTtl(interval),
        () => this.kuru.getKlines({ symbol: market.symbol, interval, limit: count, endTime: end }),
        { staleIfErrorMs: STALE_IF_ERROR.klines },
      );
      return {
        venue: 'kuru',
        symbol: market.symbol,
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

  quote(venue: VenueId, symbol: string, request: QuoteRequestDto): Promise<QuoteDto> {
    if (venue === 'perpl') return this.perpl.quote(symbol, request);
    return this.#kuru(() => this.#kuruQuote(symbol, request));
  }

  /**
   * The price a holding is valued at. Kuru has no mark, so it is the book mid,
   * or the last 1m close when a side is empty; `null` when neither exists.
   */
  mark(venue: VenueId, symbol: string): Promise<Decimal | null> {
    if (venue === 'perpl') return this.perpl.mark(symbol);
    return this.#kuru(async () => {
      const market = this.#kuruMarket(symbol);
      const { value } = await this.#kuruDepth(market);
      const mid = midOf(value.bids[0]?.price ?? null, value.asks[0]?.price ?? null);
      if (mid !== null) return mid;
      return (await this.#kuruLast(market)).value;
    });
  }

  // -------------------------------------------------------------------------
  // Kuru

  /** Runs a Kuru read, turning anything that is not already typed into "venue down". */
  async #kuru<T>(read: () => Promise<T>): Promise<T> {
    try {
      return await read();
    } catch (error) {
      if (isMarketDataError(error)) throw error;
      throw new VenueUnavailableError('kuru', errorMessage(error));
    }
  }

  #kuruMarket(symbol: string): KuruMarketConfig {
    try {
      return this.kuru.market(symbol);
    } catch {
      throw new MarketNotFoundError('kuru', symbol);
    }
  }

  #kuruMarkets(): Promise<MarketDto[]> {
    return this.#kuruCatalog().then(({ markets }) => markets);
  }

  /**
   * The pinned markets Kuru lists, and the pinned ones it does not. A pin the
   * catalog dropped means Kuru redeployed (SEN-185); it is logged once per
   * catalog read and reported by `markets()`, never swallowed as "lists nothing".
   */
  #kuruCatalog(): Promise<{ markets: MarketDto[]; missing: string[] }> {
    return this.#kuru(async () => {
      const { value } = await this.#markets.get(
        'kuru',
        TTL.markets,
        async () => {
          const listed = await this.kuru.listedMarkets();
          if (listed.missing.length > 0) {
            this.#logger.warn(
              `${new KuruCatalogError(listed.missing).message}: the pinned Kuru deployment ` +
                '(packages/venues/src/kuru/constants.ts) no longer matches what Kuru lists',
            );
          }
          return { markets: listed.markets, missing: [...listed.missing] };
        },
        { staleIfErrorMs: STALE_IF_ERROR.markets },
      );
      return { markets: value.markets.map(kuruMarketDto), missing: value.missing };
    });
  }

  #kuruDepth(market: KuruMarketConfig): Promise<CacheResult<Depth>> {
    return this.#depth.get(
      market.symbol,
      TTL.depth,
      () => this.kuru.getDepth({ symbol: market.symbol, limit: DEPTH_LEVELS }),
      { staleIfErrorMs: STALE_IF_ERROR.depth },
    );
  }

  /** `last` is the latest FINALIZED 1m close: Kuru publishes no trade tape. */
  #kuruLast(market: KuruMarketConfig): Promise<CacheResult<Decimal | null>> {
    return this.#last.get(
      market.symbol,
      TTL.last,
      async () => {
        const klines = await this.kuru.getKlines({
          symbol: market.symbol,
          interval: '1m',
          limit: 2,
        });
        return klines.at(-1)?.close ?? null;
      },
      { staleIfErrorMs: STALE_IF_ERROR.last },
    );
  }

  /**
   * The rolling 24h window from 25 hourly candles: 24 whole hours plus the
   * current partial one, so every candle that overlaps "the last 24h" counts.
   */
  #kuruDay(market: KuruMarketConfig): Promise<CacheResult<DayStats | null>> {
    return this.#day.get(
      market.symbol,
      TTL.day,
      async () => {
        const klines = await this.kuru.getKlines({
          symbol: market.symbol,
          interval: '1h',
          limit: 25,
        });
        const since = Date.now() - DAY;
        return dayStats(klines.filter((kline) => kline.closeTime >= since));
      },
      { staleIfErrorMs: STALE_IF_ERROR.day },
    );
  }

  async #venueTickers(venue: VenueId): Promise<TickerDto[]> {
    if (venue === 'perpl') return this.perpl.tickers();
    const markets = await this.#kuruMarkets();
    const results = await Promise.allSettled(markets.map((m) => this.#kuruTicker(m.symbol)));
    const tickers = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
    // One unreadable market is dropped; every market unreadable is the venue down.
    if (markets.length > 0 && tickers.length === 0) {
      throw (results[0] as PromiseRejectedResult).reason;
    }
    return tickers;
  }

  #kuruTicker(symbol: string): Promise<TickerDto> {
    return this.#kuru(async () => {
      const market = this.#kuruMarket(symbol);
      // The book is required; candles only enrich it, so their failure
      // (with nothing cached) nulls those fields instead of failing the ticker.
      const [depth, last, day] = await Promise.all([
        this.#kuruDepth(market),
        this.#kuruLast(market).catch(() => undefined),
        this.#kuruDay(market).catch(() => undefined),
      ]);
      const bid = depth.value.bids[0]?.price ?? null;
      const ask = depth.value.asks[0]?.price ?? null;
      const stats = day?.value ?? null;
      const lastPrice = last?.value ?? stats?.close ?? null;
      return {
        venue: 'kuru',
        symbol: market.symbol,
        quote: quoteCurrency(market.quote.symbol),
        last: lastPrice,
        mark: null,
        index: null,
        bid,
        ask,
        mid: midOf(bid, ask),
        ...dayFields(lastPrice, stats),
        funding: null,
        stale: depth.stale || Boolean(last?.stale) || Boolean(day?.stale),
        // The prices' age, not the 24h window's: that rides a 60 s cache and
        // would age a fresh book past the phone's 30 s "paused" rule (SEN-179).
        asOf: Math.min(depth.loadedAt, last?.loadedAt ?? Infinity),
      };
    });
  }

  async #kuruQuote(symbol: string, request: QuoteRequestDto): Promise<QuoteDto> {
    const market = this.#kuruMarket(symbol);
    const { value: book, stale } = await this.#book.get(
      market.symbol,
      TTL.book,
      () => this.kuru.bookSnapshot(market.symbol),
      { staleIfErrorMs: STALE_IF_ERROR.book },
    );
    const { params } = book;
    const { side } = request;
    const pd = precisionDecimals(params.pricePrecision);
    const sd = precisionDecimals(params.sizePrecision);

    let wanted: bigint;
    try {
      wanted = toUnits(request.size, sd, 'size');
    } catch (error) {
      if (error instanceof KuruUnitsError) throw new InvalidSizeError(error.message);
      throw error;
    }
    if (wanted === 0n) throw new InvalidSizeError('size must be greater than zero');

    const simulated = simulateQuote({
      symbol: market.symbol,
      side,
      size: request.size,
      params,
      quoteDecimals: market.quote.decimals,
      bids: book.bids,
      asks: book.asks,
      observedAt: book.observedAt,
    });

    const best = side === 'buy' ? book.bestAsk : book.bestBid;
    const worstPrice =
      best === null ? null : kuruSlippageBound(best, side, request.maxSlippage, params);
    const withinBound =
      worstPrice === null
        ? 0n
        : fillableWithin(
            side === 'buy' ? book.asks : book.bids,
            side,
            toUnits(worstPrice, pd),
            wanted,
          );

    const filled = toUnits(simulated.fillableSize, sd);
    // Notional in quote atoms (floored) against the chain's floor, also in atoms.
    const notionalAtoms = x18(simulated.notional) / 10n ** BigInt(SCALE - market.quote.decimals);
    return {
      venue: 'kuru',
      symbol: market.symbol,
      side,
      size: request.size,
      fillableSize: simulated.fillableSize,
      averagePrice: filled > 0n ? simulated.averagePrice : null,
      notional: simulated.notional,
      estimatedFee: simulated.estimatedFee ?? '0',
      feeAsset: quoteCurrency(market.quote.symbol),
      slippageVsMid: simulated.slippage,
      maxSlippage: request.maxSlippage,
      worstPrice,
      fillableWithinWorstPrice: fromUnits(withinBound, sd),
      partial: withinBound < wanted,
      minNotionalOk: filled > 0n ? notionalAtoms >= params.minQuoteNotional : false,
      bookAsOf: book.observedAt,
      stale,
    };
  }
}

// ---------------------------------------------------------------------------
// Pure helpers

/**
 * How much of `wanted` rests at or inside `bound` (book units). An IOC at the
 * bound fills exactly this and cancels the rest — the "filled 62%" the app
 * warns about before the user signs.
 */
export function fillableWithin(
  levels: readonly BookLevel[],
  side: Side,
  bound: bigint,
  wanted: bigint,
): bigint {
  let filled = 0n;
  for (const level of levels) {
    const inside = side === 'buy' ? level.price <= bound : level.price >= bound;
    if (!inside || filled >= wanted) break;
    filled += level.size < wanted - filled ? level.size : wanted - filled;
  }
  return filled;
}

function kuruMarketDto(market: Market): MarketDto {
  return {
    venue: 'kuru',
    symbol: market.symbol,
    venueSymbol: market.venueSymbol ?? market.symbol,
    kind: market.kind,
    base: market.base,
    quote: quoteCurrency(market.quote),
    tickSize: market.tickSize,
    stepSize: market.stepSize,
    minSize: market.minSize,
    minNotional: market.minNotional ?? null,
    maxLeverage: null,
    marginMode: null,
    makerFee: required(market.makerFee, `${market.symbol} makerFee`),
    takerFee: required(market.takerFee, `${market.symbol} takerFee`),
  };
}

export function dayStats(klines: readonly Kline[]): DayStats | null {
  const first = klines[0];
  const newest = klines.at(-1);
  if (!first || !newest) return null;
  let high = x18(first.high);
  let low = x18(first.low);
  let volume: bigint | null = 0n;
  for (const kline of klines) {
    const h = x18(kline.high);
    const l = x18(kline.low);
    if (h > high) high = h;
    if (l < low) low = l;
    volume =
      volume === null || kline.quoteVolume === undefined ? null : volume + x18(kline.quoteVolume);
  }
  return {
    open: first.open,
    high: fromX18(high),
    low: fromX18(low),
    quoteVolume: volume === null ? null : fromX18(volume),
    close: newest.close,
  };
}

/** The ticker's 24h fields from a window's stats and the current `last`; all null without stats. */
export function dayFields(
  last: Decimal | null,
  stats: DayStats | null,
): Pick<
  TickerDto,
  'open24h' | 'high24h' | 'low24h' | 'change24h' | 'change24hPct' | 'quoteVolume24h'
> {
  const change = last !== null && stats !== null ? x18(last) - x18(stats.open) : null;
  const openX18 = stats ? x18(stats.open) : 0n;
  return {
    open24h: stats?.open ?? null,
    high24h: stats?.high ?? null,
    low24h: stats?.low ?? null,
    change24h: change === null ? null : fromX18(change),
    change24hPct: change === null || openX18 === 0n ? null : ratioToDecimal(change, openX18),
    quoteVolume24h: stats?.quoteVolume ?? null,
  };
}

export function midOf(bid: Decimal | null, ask: Decimal | null): Decimal | null {
  if (bid === null || ask === null) return null;
  return ratioToDecimal(x18(bid) + x18(ask), 2n * 10n ** BigInt(SCALE));
}

/** USDC (Kuru) and AUSD (Perpl) are never interchangeable, so anything else is a bug, not a guess. */
export function quoteCurrency(symbol: string): QuoteCurrency {
  if (symbol === 'USDC' || symbol === 'AUSD') return symbol;
  throw new Error(`unexpected quote currency ${symbol}`);
}

/** Absent fees mean unknown, not free (`Market.makerFee`); never publish them as zero. */
function required(value: Decimal | undefined, what: string): Decimal {
  if (value === undefined) throw new Error(`${what} is missing from the venue catalog`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
