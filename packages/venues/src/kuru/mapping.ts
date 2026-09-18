/**
 * Kuru wire data and receipts -> Sente's venue types. Pure, so
 * `mapping.test.ts` pins every conversion without a network.
 */
import type {
  Depth,
  Kline,
  KlineInterval,
  Market,
  Order,
  OrderStatus,
  OrderType,
  Quote,
  Side,
  TimeInForce,
} from '../types.ts';
import type { ApiCandles, ApiDepth, ApiMarket, ApiOpenOrder, CandleInterval } from './api.ts';
import type { KuruMarketConfig } from './constants.ts';
import {
  formatOrderId,
  PPS_DENOMINATOR,
  type KuruMarketParams,
  type KuruOrderOutcome,
} from './orders.ts';
import { fromUnits, precisionDecimals, ratioToDecimal, toUnits } from './units.ts';

type Precisions = Pick<KuruMarketConfig, 'pricePrecision' | 'sizePrecision'>;

const priceDecimals = (market: Precisions) => precisionDecimals(market.pricePrecision);
const sizeDecimals = (market: Precisions) => precisionDecimals(market.sizePrecision);

export function toMarket(api: ApiMarket, config: KuruMarketConfig): Market {
  const step = fromUnits(1n, precisionDecimals(BigInt(api.sizePrecision)));
  return {
    symbol: config.symbol,
    kind: 'spot',
    base: config.base.symbol,
    quote: config.quote.symbol,
    tickSize: fromUnits(BigInt(api.tickSize), precisionDecimals(BigInt(api.pricePrecision))),
    stepSize: step,
    // Kuru enforces a quote-notional floor, not a base-size floor, so the
    // smallest base size it will parse is one step. `minNotional` is the rule.
    minSize: step,
    minNotional: fromUnits(BigInt(api.minQuoteNotionalX18), 18),
    venueSymbol: api.symbol,
  };
}

export function toDepth(
  api: ApiDepth,
  market: KuruMarketConfig,
  limit: number,
  observedAt: number,
): Depth {
  const level = (raw: { price: string; total_base: string }) => ({
    price: fromUnits(BigInt(raw.price), priceDecimals(market)),
    size: fromUnits(BigInt(raw.total_base), sizeDecimals(market)),
  });
  return {
    symbol: market.symbol,
    bids: api.bids.slice(0, limit).map(level),
    asks: api.asks.slice(0, limit).map(level),
    // The Gateway stamps a sequence, not a time.
    timestamp: observedAt,
    sequence: api.market_seq,
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const KLINE_INTERVAL_MS: Record<KlineInterval, number> = {
  '1m': MINUTE,
  '5m': 5 * MINUTE,
  '15m': 15 * MINUTE,
  '30m': 30 * MINUTE,
  '1h': HOUR,
  '4h': 4 * HOUR,
  '1d': DAY,
  '1w': 7 * DAY,
};

/**
 * Kuru materializes 1s/1m/5m/1h/6h/1d candles. Each Sente interval is read at
 * the largest native interval that divides it evenly and aggregated up.
 */
export const KLINE_SOURCE: Record<KlineInterval, CandleInterval & KlineInterval> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '5m',
  '30m': '5m',
  '1h': '1h',
  '4h': '1h',
  '1d': '1d',
  '1w': '1d',
};

/** Weeks open Monday 00:00 UTC, as on every major venue; the Unix epoch was a Thursday. */
const WEEK_OFFSET_MS = 4 * DAY;

export function bucketStart(openTime: number, interval: KlineInterval): number {
  const width = KLINE_INTERVAL_MS[interval];
  const offset = interval === '1w' ? WEEK_OFFSET_MS : 0;
  return Math.floor((openTime - offset) / width) * width + offset;
}

type Bucket = {
  open: bigint;
  high: bigint;
  low: bigint;
  close: bigint;
  quoteX18: bigint;
  baseX18: bigint;
};

/**
 * Kuru candles -> Sente klines at `interval`, oldest first.
 *
 * `Kline.volume` is an ESTIMATE. Kuru reports quote volume only; base volume
 * is derived per native candle as quote volume over that candle's typical
 * price `(h + l + c) / 3`. `quoteVolume` is exact.
 */
export function toKlines(
  api: ApiCandles,
  market: KuruMarketConfig,
  interval: KlineInterval,
): Kline[] {
  const buckets = new Map<number, Bucket>();

  for (let i = 0; i < api.t.length; i++) {
    const open = BigInt(api.o[i]!);
    const high = BigInt(api.h[i]!);
    const low = BigInt(api.l[i]!);
    const close = BigInt(api.c[i]!);
    const quoteX18 = BigInt(api.v[i]!);
    const typicalX3 = high + low + close;
    // quote / (typical / pricePrecision), still scaled by 1e18.
    const baseX18 = typicalX3 === 0n ? 0n : (quoteX18 * market.pricePrecision * 3n) / typicalX3;

    const key = bucketStart(api.t[i]! * 1000, interval);
    const bucket = buckets.get(key);
    if (!bucket) {
      buckets.set(key, { open, high, low, close, quoteX18, baseX18 });
    } else {
      if (high > bucket.high) bucket.high = high;
      if (low < bucket.low) bucket.low = low;
      bucket.close = close;
      bucket.quoteX18 += quoteX18;
      bucket.baseX18 += baseX18;
    }
  }

  const width = KLINE_INTERVAL_MS[interval];
  const pd = priceDecimals(market);
  const sd = sizeDecimals(market);
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([openTime, b]) => ({
      openTime,
      closeTime: openTime + width - 1,
      open: fromUnits(b.open, pd),
      high: fromUnits(b.high, pd),
      low: fromUnits(b.low, pd),
      close: fromUnits(b.close, pd),
      volume: fromUnits(b.baseX18 / 10n ** BigInt(18 - sd), sd),
      quoteVolume: fromUnits(b.quoteX18, 18),
    }));
}

/**
 * One Gateway open order. The snapshot carries remaining size only and no
 * timestamps, so `size` is the REMAINING size, `filledSize` is `"0"`, and both
 * times are when the snapshot was read.
 */
export function toOpenOrder(
  api: ApiOpenOrder,
  market: KuruMarketConfig,
  observedAt: number,
): Order {
  return {
    id: formatOrderId({ slotIdx: api.slotIdx, orderId: BigInt(api.orderId) }),
    clientOrderId: api.clientOrderId ?? undefined,
    symbol: market.symbol,
    side: api.isBuy ? 'buy' : 'sell',
    type: 'limit',
    status: 'open',
    price: fromUnits(BigInt(api.price), priceDecimals(market)),
    size: fromUnits(BigInt(api.remainingSize), sizeDecimals(market)),
    filledSize: '0',
    createdAt: observedAt,
    updatedAt: observedAt,
  };
}

/** One aggregated book level, in book units. */
export type BookLevel = {
  readonly price: bigint;
  readonly size: bigint;
};

export type QuoteInput = {
  readonly symbol: string;
  readonly side: Side;
  readonly size: string;
  readonly params: KuruMarketParams;
  readonly quoteDecimals: number;
  /** Best first. */
  readonly bids: readonly BookLevel[];
  /** Best first. */
  readonly asks: readonly BookLevel[];
  readonly observedAt: number;
};

/**
 * Walks the book for a taker order of `size`. Reads only.
 *
 * Slippage is measured against the mid when both sides are populated, and
 * against the best price on the side being taken when only that side is.
 * Resting depth is reported at stored size, which can overstate what a stale
 * reduce-after-block order will actually fill — Kuru's own caveat.
 */
export function simulateQuote(input: QuoteInput): Quote {
  const { params, side } = input;
  const pd = precisionDecimals(params.pricePrecision);
  const sd = precisionDecimals(params.sizePrecision);
  const wanted = toUnits(input.size, sd, 'size');
  const levels = side === 'buy' ? input.asks : input.bids;

  let filled = 0n;
  let priceTimesSize = 0n;
  for (const level of levels) {
    if (filled >= wanted) break;
    const take = level.size < wanted - filled ? level.size : wanted - filled;
    filled += take;
    priceTimesSize += level.price * take;
  }

  const bestBid = input.bids[0]?.price;
  const bestAsk = input.asks[0]?.price;
  // Twice the reference price, so the mid stays an integer.
  const referenceX2 =
    bestBid !== undefined && bestAsk !== undefined
      ? bestBid + bestAsk
      : levels[0] !== undefined
        ? levels[0].price * 2n
        : undefined;

  let slippage = '0';
  if (filled > 0n && referenceX2 !== undefined) {
    // (average - reference) / reference, with both scaled by 2 * filled.
    const adverse = 2n * priceTimesSize - filled * referenceX2;
    slippage = ratioToDecimal(side === 'buy' ? adverse : -adverse, filled * referenceX2);
  }

  const notionalScale = 10n ** BigInt(pd + sd);
  return {
    symbol: input.symbol,
    side,
    size: input.size,
    fillableSize: fromUnits(filled, sd),
    averagePrice:
      filled > 0n ? ratioToDecimal(priceTimesSize, filled * params.pricePrecision) : '0',
    notional: fromUnits(priceTimesSize, pd + sd),
    slippage,
    estimatedFee: ratioToDecimal(
      priceTimesSize * params.takerFeePps,
      notionalScale * PPS_DENOMINATOR,
      input.quoteDecimals,
    ),
    timestamp: input.observedAt,
  };
}

export type PlacedOrderInput = {
  readonly symbol: string;
  readonly side: Side;
  readonly type: OrderType;
  readonly timeInForce: TimeInForce;
  /** Requested size, in book units. */
  readonly quantity: bigint;
  /** Limit price as the caller gave it. Omitted for market orders. */
  readonly price?: string;
  readonly clientOrderId?: string;
  readonly params: KuruMarketParams;
  readonly outcome: KuruOrderOutcome;
  /** UserOperation hash for a smart account; tx hash for an EOA. */
  readonly executionHash: string;
  readonly transactionHash: string;
  readonly observedAt: number;
  /**
   * Block the execution was confirmed in (SEN-20), from the receipt. Absent
   * when the submitter did not surface one.
   */
  readonly blockNumber?: number;
  /** Quote-token decimals and symbol: what `fee`/`feeAsset` are reported in. */
  readonly quoteDecimals?: number;
  readonly feeAsset?: string;
};

/**
 * Taker fee actually paid on the fills of one execution, in quote-token atoms:
 * `notional × pps / 10_000_000`, where `priceTimesSize` is in book units
 * (scaled `10^(pd+sd)`) and the notional lives in quote atoms. One floor, at
 * the atom — a fee fraction of an atom is never charged, so flooring here
 * cannot overstate it.
 */
function takerFeeAtoms(
  priceTimesSize: bigint,
  takerFeePps: bigint,
  pricePrecision: bigint,
  sizePrecision: bigint,
  quoteDecimals: number,
): bigint {
  const bookScale = precisionDecimals(pricePrecision) + precisionDecimals(sizePrecision);
  return (
    (priceTimesSize * takerFeePps * 10n ** BigInt(quoteDecimals)) /
    (PPS_DENOMINATOR * 10n ** BigInt(bookScale))
  );
}

/** A placement's decoded outcome as a Sente `Order`. */
export function toPlacedOrder(input: PlacedOrderInput): Order {
  const { outcome, params } = input;
  const sd = precisionDecimals(params.sizePrecision);

  let filled = 0n;
  let priceTimesSize = 0n;
  for (const fill of outcome.fills) {
    filled += fill.size;
    priceTimesSize += fill.price * fill.size;
  }
  // One order was placed, so at most one of this account's orders rested.
  const rested = outcome.rested.at(-1);
  // The taker fee actually applied, when anything was taken (SEN-20).
  const takerFee =
    outcome.takerFeePps !== undefined && filled > 0n && input.quoteDecimals !== undefined
      ? fromUnits(
          takerFeeAtoms(
            priceTimesSize,
            outcome.takerFeePps,
            params.pricePrecision,
            params.sizePrecision,
            input.quoteDecimals,
          ),
          input.quoteDecimals,
        )
      : undefined;

  let status: OrderStatus;
  if (rested) {
    status = filled > 0n ? 'partially_filled' : 'open';
  } else if (filled >= input.quantity) {
    status = 'filled';
  } else if (input.type === 'market' || input.timeInForce === 'IOC') {
    status = filled > 0n ? 'cancelled' : 'expired'; // the unfilled remainder is discarded
  } else if (filled > 0n) {
    status = 'filled'; // a remainder too small to settle one quote atom is removed as dust
  } else {
    status = 'rejected'; // a crossing POST_ONLY is skipped, not reverted
  }

  return {
    id: rested ? formatOrderId(rested) : input.executionHash,
    clientOrderId: input.clientOrderId,
    symbol: input.symbol,
    side: input.side,
    type: input.type,
    status,
    price: input.price,
    size: fromUnits(input.quantity, sd),
    filledSize: fromUnits(filled, sd),
    averageFillPrice:
      filled > 0n ? ratioToDecimal(priceTimesSize, filled * params.pricePrecision) : undefined,
    timeInForce: input.timeInForce,
    createdAt: input.observedAt,
    updatedAt: input.observedAt,
    txHash: input.transactionHash,
    ...(input.blockNumber !== undefined ? { blockNumber: input.blockNumber } : {}),
    ...(takerFee !== undefined ? { fee: takerFee } : {}),
    ...(takerFee !== undefined && input.feeAsset !== undefined ? { feeAsset: input.feeAsset } : {}),
  };
}
