/**
 * Perpl market data without credentials (SEN-69).
 *
 * Everything a market-data reader needs — the catalog, book maths, candles,
 * slippage bounds — as pure functions over Perpl's wire shapes, plus
 * `PerplMarketData`, a reader that holds no API key. The API's shared
 * market-data service reads through it, so a price screen never needs an
 * agent's credentials; `PerplVenue` calls the same helpers, so the two cannot
 * drift apart.
 *
 * Nothing here opens a socket: the book is passed in, so a caller holding one
 * long-lived market-data socket (the API's book feed) can quote from it
 * instead of opening a fresh one per read.
 */
import type {
  Decimal,
  Depth,
  DepthLevel,
  Kline,
  KlineInterval,
  KlineQuery,
  Market,
  MarketSymbol,
  Quote,
  QuoteRequest,
  Side,
} from '../types.ts';
import { divRound, fromScaled, toScaled, unit } from './decimal.ts';
import { PerplRest } from './rest.ts';
import type { PerplCandleSeries, PerplContext, PerplL2Book, PerplMarket } from './wire.ts';

export interface PerplNetwork {
  readonly restUrl: string;
  readonly wsUrl: string;
  readonly chainId: number;
}

export const PERPL_NETWORKS = {
  testnet: {
    restUrl: 'https://testnet.perpl.xyz/api',
    wsUrl: 'wss://testnet.perpl.xyz',
    chainId: 10143,
  },
  mainnet: { restUrl: 'https://app.perpl.xyz/api', wsUrl: 'wss://app.perpl.xyz', chainId: 143 },
} as const satisfies Record<string, PerplNetwork>;

/** A Perpl market with its scaling resolved. */
export interface ResolvedMarket {
  readonly raw: PerplMarket;
  readonly symbol: MarketSymbol;
  /** price_decimals, size_decimals, collateral decimals. */
  readonly pd: number;
  readonly sd: number;
  readonly cd: number;
  readonly collateral: string;
}

export function resolveMarket(context: PerplContext, raw: PerplMarket): ResolvedMarket {
  const instance = context.instances.find((i) => i.id === raw.instance_id) ?? context.instances[0];
  const token = context.tokens.find((t) => t.id === instance?.collateral_token_id);
  if (!token) throw new Error(`Perpl context has no collateral token for market ${raw.symbol}`);
  return {
    raw,
    symbol: `${raw.symbol}-PERP`,
    pd: raw.config.price_decimals,
    sd: raw.config.size_decimals,
    cd: token.decimals,
    collateral: token.symbol,
  };
}

/** The open market behind a canonical symbol (`BTC-PERP`); throws when absent or closed. */
export function resolveSymbol(context: PerplContext, symbol: MarketSymbol): ResolvedMarket {
  const raw = context.markets.find((m) => `${m.symbol}-PERP` === symbol);
  if (!raw) throw new Error(`Perpl has no market ${symbol}`);
  if (!raw.config.is_open) throw new Error(`Perpl market ${symbol} is closed`);
  return resolveMarket(context, raw);
}

/**
 * The open markets. Fees are `maker_fee`/`taker_fee` micros as fractions;
 * margin is isolated-only on Perpl.
 */
export function perplMarkets(context: PerplContext): Market[] {
  return context.markets
    .filter((raw) => raw.config.is_open)
    .map((raw) => {
      const m = resolveMarket(context, raw);
      return {
        symbol: m.symbol,
        kind: 'perp',
        base: raw.symbol,
        quote: m.collateral,
        tickSize: unit(m.pd),
        stepSize: unit(m.sd),
        minSize: unit(m.sd),
        maxLeverage: raw.config.initial_margin / 100,
        venueSymbol: raw.symbol,
        makerFee: fromScaled(raw.config.maker_fee, 6),
        takerFee: fromScaled(raw.config.taker_fee, 6),
        marginMode: 'isolated',
      };
    });
}

/** Non-empty levels, best first on each side. */
function sortedBook(book: PerplL2Book) {
  return {
    bids: [...book.bid].filter((l) => l.s > 0).sort((a, b) => b.p - a.p),
    asks: [...book.ask].filter((l) => l.s > 0).sort((a, b) => a.p - b.p),
  };
}

export function bookToDepth(book: PerplL2Book, m: ResolvedMarket, limit?: number): Depth {
  const level = (l: { p: number; s: number }): DepthLevel => ({
    price: fromScaled(l.p, m.pd),
    size: fromScaled(l.s, m.sd),
  });
  const { bids, asks } = sortedBook(book);
  return {
    symbol: m.symbol,
    bids: bids.slice(0, limit ?? bids.length).map(level),
    asks: asks.slice(0, limit ?? asks.length).map(level),
    timestamp: book.at.t ?? Date.now(),
    ...(book.sn !== undefined ? { sequence: book.sn } : {}),
  };
}

/** Walks `book` for `size`. Places nothing. */
export function quoteFromBook(
  book: PerplL2Book,
  m: ResolvedMarket,
  { symbol, side, size }: QuoteRequest,
): Quote {
  const wanted = toScaled(size, m.sd);
  const { bids, asks } = sortedBook(book);

  let filled = 0n;
  let cost = 0n; // Σ price·size, scaled pd+sd
  for (const level of side === 'buy' ? asks : bids) {
    if (filled >= wanted) break;
    const take = BigInt(level.s) < wanted - filled ? BigInt(level.s) : wanted - filled;
    filled += take;
    cost += take * BigInt(level.p);
  }

  // Twice the mid, so it stays an integer.
  const mid2 = bids[0] && asks[0] ? BigInt(bids[0].p) + BigInt(asks[0].p) : 0n;
  let slippage = '0';
  if (filled > 0n && mid2 > 0n) {
    // (avg − mid) / mid  ==  (2·cost − mid2·filled) / (mid2·filled); adverse is positive.
    const adverse = side === 'buy' ? 2n * cost - mid2 * filled : mid2 * filled - 2n * cost;
    slippage = fromScaled(divRound(adverse * 10n ** 8n, mid2 * filled), 8);
  }
  return {
    symbol,
    side,
    size,
    fillableSize: fromScaled(filled, m.sd),
    averagePrice: filled > 0n ? fromScaled(divRound(cost * 10n ** 4n, filled), m.pd + 4) : '0',
    notional: fromScaled(cost, m.pd + m.sd),
    slippage,
    estimatedFee: fromScaled(
      divRound(cost * BigInt(m.raw.config.taker_fee), 1_000_000n),
      m.pd + m.sd,
    ),
    timestamp: book.at.t ?? Date.now(),
  };
}

/**
 * The worst price an immediate order may fill at, `mark ± maxSlippage`, as a
 * scaled integer. `maxSlippage` is clamped to the market's own
 * `order_max_market_slippage_bps` — Perpl refuses anything wider — and the
 * clamped fraction is returned so a caller can show what it will really get.
 * Rounded in the conservative direction: a buy's ceiling down, a sell's floor up.
 */
export function perplSlippageBoundScaled(
  markScaled: bigint,
  side: Side,
  maxSlippage: Decimal,
  m: ResolvedMarket,
): { price: bigint; micros: bigint } {
  let micros = toScaled(maxSlippage, 6, 'floor');
  const cap = BigInt(m.raw.order_max_market_slippage_bps) * 100n;
  if (micros > cap) micros = cap;
  if (micros < 0n) throw new Error(`maxSlippage must not be negative, got ${maxSlippage}`);
  const price =
    side === 'buy'
      ? (markScaled * (1_000_000n + micros)) / 1_000_000n
      : (markScaled * (1_000_000n - micros) + 999_999n) / 1_000_000n;
  return { price, micros };
}

/** `perplSlippageBoundScaled` as decimal strings. */
export function perplSlippageBound(
  markScaled: bigint,
  side: Side,
  maxSlippage: Decimal,
  m: ResolvedMarket,
): { price: Decimal; effectiveSlippage: Decimal } {
  const { price, micros } = perplSlippageBoundScaled(markScaled, side, maxSlippage, m);
  return { price: fromScaled(price, m.pd), effectiveSlippage: fromScaled(micros, 6) };
}

const INTERVAL_SECONDS: Readonly<Record<KlineInterval, number | undefined>> = {
  '1m': 60,
  '5m': 300,
  '15m': 900,
  '30m': 1800,
  '1h': 3600,
  '4h': 14400,
  '1d': 86400,
  '1w': undefined, // Perpl's longest resolution is 1d
};

const MAX_CANDLES = 1024;

/** Perpl's candle resolution in seconds; throws for intervals it does not serve. */
export function perplResolution(interval: KlineInterval): number {
  const resolution = INTERVAL_SECONDS[interval];
  if (resolution === undefined) throw new Error(`Perpl has no ${interval} candles`);
  return resolution;
}

/**
 * Candles, oldest first, clipped to `[from, to]` and the last `count`.
 *
 * `volume` IS AN ESTIMATE. Perpl publishes candle volume only in collateral
 * units (`v`), which is reported exactly as `quoteVolume`; base volume is
 * derived as `quoteVolume / typical price ((h + l + c) / 3)`. Use
 * `quoteVolume` wherever exactness matters.
 */
export function candlesToKlines(
  series: PerplCandleSeries,
  m: ResolvedMarket,
  interval: KlineInterval,
  from: number,
  to: number,
  count: number,
): Kline[] {
  const step = perplResolution(interval) * 1000;
  const candles = series.d
    .filter((c) => c.t >= from && c.t <= to)
    .sort((a, b) => a.t - b.t)
    .slice(-count);
  return candles.map((c) => {
    const quote = BigInt(c.v);
    const typical3 = BigInt(c.h) + BigInt(c.l) + BigInt(c.c); // 3 × typical, scaled pd
    // base (scaled sd) = quote / 10^cd / (typical / 10^pd) · 10^sd
    const base =
      typical3 > 0n
        ? divRound(quote * 3n * 10n ** BigInt(m.pd + m.sd), typical3 * 10n ** BigInt(m.cd))
        : 0n;
    return {
      openTime: c.t,
      closeTime: c.t + step,
      open: fromScaled(c.o, m.pd),
      high: fromScaled(c.h, m.pd),
      low: fromScaled(c.l, m.pd),
      close: fromScaled(c.c, m.pd),
      volume: fromScaled(base, m.sd),
      quoteVolume: fromScaled(quote, m.cd),
    };
  });
}

/** Fetches and maps the candles a `KlineQuery` asks for. */
export async function fetchPerplKlines(
  rest: PerplRest,
  m: ResolvedMarket,
  { interval, startTime, endTime, limit }: KlineQuery,
): Promise<Kline[]> {
  const resolution = perplResolution(interval);
  const to = (endTime ?? Date.now()) - 1; // endTime is exclusive
  const count = Math.min(limit ?? 100, MAX_CANDLES);
  const from = startTime ?? to - count * resolution * 1000;
  const series = await rest.candles(m.raw.id, resolution, from, to);
  return candlesToKlines(series, m, interval, from, to, count);
}

/** A market's prices as `/pub/context` last reported them. */
export interface PerplPriceState {
  readonly mark: Decimal;
  readonly last: Decimal;
  readonly mid: Decimal;
  readonly bid: Decimal;
  readonly ask: Decimal;
  /** The oracle price (`orl`); null when Perpl reports none. */
  readonly index: Decimal | null;
  readonly at: number;
}

export interface PerplMarketDataOptions {
  /** Defaults to testnet. */
  readonly network?: PerplNetwork;
  readonly fetchImpl?: typeof fetch;
  /** How stale `/pub/context` may be. Default 10s. */
  readonly contextMaxAgeMs?: number;
}

/** Perpl's public reads, with a cached `/pub/context`. Holds no credentials. */
export class PerplMarketData {
  readonly rest: PerplRest;
  private readonly contextMaxAgeMs: number;
  private cached: { context: PerplContext; at: number } | null = null;
  private inflight: Promise<PerplContext> | null = null;

  constructor(options: PerplMarketDataOptions = {}) {
    const network = options.network ?? PERPL_NETWORKS.testnet;
    this.contextMaxAgeMs = options.contextMaxAgeMs ?? 10_000;
    this.rest = new PerplRest({
      restUrl: network.restUrl,
      chainId: network.chainId,
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
  }

  /**
   * The context, refetched when older than `maxAgeMs`. Concurrent callers
   * share one request, so a burst of readers costs Perpl a single fetch.
   */
  async context(maxAgeMs = this.contextMaxAgeMs): Promise<PerplContext> {
    if (this.cached && Date.now() - this.cached.at <= maxAgeMs) return this.cached.context;
    this.inflight ??= this.rest
      .context()
      .then((context) => {
        this.cached = { context, at: Date.now() };
        return context;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  async getMarkets(): Promise<Market[]> {
    return perplMarkets(await this.context());
  }

  async resolve(symbol: MarketSymbol): Promise<ResolvedMarket> {
    return resolveSymbol(await this.context(), symbol);
  }

  async getKlines(query: KlineQuery): Promise<Kline[]> {
    return fetchPerplKlines(this.rest, await this.resolve(query.symbol), query);
  }

  async state(symbol: MarketSymbol): Promise<PerplPriceState> {
    const m = await this.resolve(symbol);
    const s = m.raw.state;
    return {
      mark: fromScaled(s.mrk, m.pd),
      last: fromScaled(s.lst, m.pd),
      mid: fromScaled(s.mid, m.pd),
      bid: fromScaled(s.bid, m.pd),
      ask: fromScaled(s.ask, m.pd),
      index: s.orl > 0 ? fromScaled(s.orl, m.pd) : null,
      at: s.at.t ?? Date.now(),
    };
  }
}
