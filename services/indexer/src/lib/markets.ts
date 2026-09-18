/**
 * Market + daily-aggregate writes, shared by the Kuru and Perpl handler files.
 *
 * Markets are seeded (never inferred): Kuru's four OrderBook proxies come from
 * src/lib/seeds.ts, Perpl's from its live `/api/v1/pub/context` snapshot, and a
 * Perpl market listed *inside* the indexed range is added by `ContractAdded`.
 * A handler that cannot resolve its market refuses the event rather than
 * guessing a precision — a wrong price scale silently corrupts every USD figure
 * downstream, so silence is the cheaper failure.
 */
import { BigDecimal } from 'envio';
import { addBd, bd, type Ctx } from './common.ts';
import {
  KURU_MARKET_SEEDS,
  PERPL_MARKET_SEEDS,
  type MarketSeed,
} from './seeds.ts';
import { dayId, yyyymmdd } from './stats.ts';

/** Create the market row if it is not there yet; idempotent. */
export async function ensureMarket(context: Ctx, seed: MarketSeed): Promise<void> {
  if ((await context.Market.get(seed.marketId)) !== undefined) return;
  context.Market.set({
    id: seed.marketId,
    venue: seed.venue,
    symbol: seed.symbol,
    base: seed.base,
    quote: seed.quote,
    pricePrecision: seed.pricePrecision,
    sizePrecision: seed.sizePrecision,
    baseDecimals: seed.baseDecimals,
    quoteDecimals: seed.quoteDecimals,
    address: seed.address,
    tradeCount: 0,
    volumeUsd: new BigDecimal('0'),
    latestTradeBlock: undefined,
  });
}

export async function ensureKuruMarkets(context: Ctx): Promise<void> {
  for (const seed of KURU_MARKET_SEEDS) await ensureMarket(context, seed);
}

export async function ensurePerplMarkets(context: Ctx): Promise<void> {
  for (const seed of PERPL_MARKET_SEEDS) await ensureMarket(context, seed);
}

/** Market rollup: one increment per *match*, not per leg (see schema.graphql). */
export async function bumpMarket(
  context: Ctx,
  marketId: string,
  notionalBd: BigDecimal,
  blockNumber: number,
): Promise<void> {
  const market = await context.Market.getOrThrow(marketId);
  context.Market.set({
    ...market,
    tradeCount: market.tradeCount + 1,
    volumeUsd: addBd(market.volumeUsd, notionalBd),
    latestTradeBlock: BigInt(blockNumber),
  });
}

export type MarketDayInput = {
  readonly marketId: string;
  /** the taker's side; the day's buy/sell split counts matches, not legs */
  readonly isBuy: boolean;
  readonly notionalBd: BigDecimal;
  readonly baseBd: BigDecimal;
  readonly priceBd: BigDecimal;
  /** every account that participated in the match — both legs */
  readonly accountIds: readonly string[];
  readonly timestampSec: number;
};

/** One UTC calendar day per market, incremented per match. */
export async function recordMarketDay(context: Ctx, args: MarketDayInput): Promise<void> {
  const day = yyyymmdd(args.timestampSec);
  const id = dayId(args.marketId, day);
  const existing = await context.MarketDay.get(id);
  const row = existing ?? {
    id,
    market_id: args.marketId,
    day,
    date: new Date(Math.floor(args.timestampSec / 86_400) * 86_400_000),
    tradeCount: 0,
    buyCount: 0,
    sellCount: 0,
    volumeUsd: new BigDecimal('0'),
    baseVolume: new BigDecimal('0'),
    highPrice: undefined,
    lowPrice: undefined,
    vwapPrice: undefined,
    activeAccountIds: [] as readonly string[],
  };

  const active = [...row.activeAccountIds];
  for (const accountId of args.accountIds) {
    if (!active.includes(accountId)) active.push(accountId);
  }
  const high =
    row.highPrice === undefined || args.priceBd.gt(row.highPrice) ? args.priceBd : row.highPrice;
  const low =
    row.lowPrice === undefined || args.priceBd.lt(row.lowPrice) ? args.priceBd : row.lowPrice;
  const volumeUsd = addBd(row.volumeUsd, args.notionalBd);
  const baseVolume = addBd(row.baseVolume, args.baseBd);

  context.MarketDay.set({
    ...row,
    tradeCount: row.tradeCount + 1,
    buyCount: row.buyCount + (args.isBuy ? 1 : 0),
    sellCount: row.sellCount + (args.isBuy ? 0 : 1),
    volumeUsd,
    baseVolume,
    highPrice: high,
    lowPrice: low,
    // Quote per base over the day. Division is the only rounding step in the
    // aggregates, so it is given an explicit precision instead of inheriting
    // bignumber.js's default of 20 — but that precision is `decimalPlaces`,
    // NOT a second argument to `div`: bignumber.js reads `div(y, base)` as the
    // numeric BASE of the operands. `div(x, 18)` therefore reparsed both
    // operands as base-18 numerals (the live MON-USDC fill came out 0.009867
    // instead of 0.030974) and returned NaN whenever an operand carried an
    // exponent. See markets.test.ts.
    vwapPrice: baseVolume.isZero() ? undefined : volumeUsd.div(baseVolume).decimalPlaces(18),
    activeAccountIds: active,
  });
}
