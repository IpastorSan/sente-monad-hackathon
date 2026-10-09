/**
 * The agent's tools, each defined ONCE: a zod schema, a kind, and a handler.
 * `gate.ts` wraps them; `anthropic.ts` and `mcp.ts` expose the gated tools to
 * the Tool Runner and to MCP clients. Nothing here enforces the mandate — the
 * gate does, before a handler ever runs.
 *
 * A write tool can declare two hooks the gate reads:
 * - `thesisMarket`: the market whose `record_thesis` must already be on record
 *   in this run. Cancel, close and withdraw have none: reducing risk is never
 *   gated.
 * - `intent`: what `checkIntent` (layer 1) judges.
 */
import {
  compareDecimal,
  retiredKuruMessage,
  retiredKuruReferences,
  type Intent,
  type Mandate,
} from '@sente/mandate';
import type { Decimal, Kline, Side } from '@sente/venues';
import {
  fromUnits,
  KURU_TESTNET_MARKETS,
  KURU_TESTNET_TOKENS,
  toUnits,
  type KuruToken,
} from '@sente/venues/kuru';
import { divRound, fromScaled, PERPL_COLLATERAL_DECIMALS, toScaled } from '@sente/venues/perpl';
import { isAddressEqual } from 'viem';
import * as z from 'zod/v4';

import type { KlineDto, KlineInterval } from '../../venues/dto/markets.dto';
import {
  IntervalNotSupportedError,
  InvalidSizeError,
  KLINE_WIDTH_MS,
  MarketNotFoundError,
} from '../../venues/market-data.service';
import { toMandateDto } from '../dto/agent.dto';
import type { AgentRecord } from '../store/agent-store';
import type { KuruToolVenue, ToolContext, ToolVenues } from './context';
import { decimalsOf, isPositiveDecimal, maxDecimal, mulDecimal } from './decimal';
import { checkSpec, indicatorSpec, KLINE_INTERVALS } from './indicator-schema';
import { summarize, type SourceCandle } from './indicators';
import { fetchSmartMoneySignals, NansenClient } from './nansen';
import { invalidInput, SenteRefusal } from './refusals';
import type { WatcherSetView } from '../watchers/watcher.service';
import {
  MAX_CLAUSES,
  MAX_WATCHERS,
  WatcherInvalidError,
  watcherSetInput,
} from '../watchers/watcher.schema';

export type ToolKind = 'read' | 'write';

export interface AgentTool<S extends z.ZodType = z.ZodType> {
  readonly name: string;
  readonly description: string;
  readonly input: S;
  readonly kind: ToolKind;
  /**
   * A write that never reaches the enclave (a thesis, the watchers): the
   * runner does not space it like a signing write. Writes sign by default.
   */
  readonly signs?: false;
  thesisMarket?(args: z.output<S>): string;
  intent?(ctx: ToolContext, args: z.output<S>): Promise<Intent>;
  handler(ctx: ToolContext, args: z.output<S>): Promise<unknown>;
}

function defineTool<S extends z.ZodType>(tool: AgentTool<S>): AgentTool {
  return tool as AgentTool;
}

// ---------------------------------------------------------------------------
// Shared schemas

const VENUE_IDS = ['kuru', 'perpl'] as const;
type ToolVenueId = (typeof VENUE_IDS)[number];

const venue = z
  .enum(VENUE_IDS)
  .describe('"kuru" is Kuru spot order books; "perpl" is Perpl perpetual futures.');
const market = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,64}$/, 'a market symbol such as "MON-USDC" or "BTC-PERP"')
  .describe('Market symbol, e.g. "MON-USDC" on Kuru or "BTC-PERP" on Perpl.');
const decimal = z
  .string()
  .regex(/^(0|[1-9]\d*)(\.\d+)?$/, 'a plain decimal string such as "12.5": no sign or exponent');
const positive = decimal.refine(isPositiveDecimal, 'must be greater than zero');
const side = z.enum(['buy', 'sell']);
const leverage = z
  .number()
  .positive()
  .max(100)
  .describe('Perpl only, and required there: leverage for this order, e.g. 3 for 3x.');
const reduceOnly = z
  .boolean()
  .describe('Perpl only: only ever reduce an open position, never open or flip one.');
const clientOrderId = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,32}$/)
  .describe('Your own idempotency key for this order.');

// ---------------------------------------------------------------------------
// Helpers

export class VenueUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VenueUnavailableError';
  }
}

function requirePerpl(venues: ToolVenues) {
  if (!venues.perpl) {
    throw new VenueUnavailableError(
      'Perpl is not set up for this agent yet: its wallet has not enrolled a Perpl API key' +
        (venues.perplUnavailable ? ` (${venues.perplUnavailable})` : ''),
    );
  }
  return venues.perpl;
}

function venueOf(venues: ToolVenues, id: ToolVenueId) {
  return id === 'kuru' ? venues.kuru : requirePerpl(venues);
}

/**
 * What `checkIntent` calls the market: the OrderBook address on Kuru, the
 * symbol on Perpl. An unknown Kuru symbol stays a symbol, which the mandate
 * refuses as `market_not_allowed` rather than as a venue error.
 */
function mandateMarket(venues: ToolVenues, id: ToolVenueId, symbol: string): string {
  if (id !== 'kuru') return symbol;
  try {
    return venues.kuru.market(symbol).address;
  } catch {
    return symbol;
  }
}

/**
 * Whether the mandate lets the agent trade `market`, named as `mandateMarket`
 * names it (the OrderBook address on Kuru, the symbol on Perpl), on `id`.
 */
function marketAllowed(mandate: Mandate, id: ToolVenueId, market: string): boolean {
  if (!mandate.venues.includes(id)) return false;
  return id === 'kuru'
    ? mandate.kuru.markets.some((a) => a.toLowerCase() === market.toLowerCase())
    : mandate.perpl.markets.includes(market);
}

/**
 * Order notional in quote units, as the cap should see it. A buy never pays
 * more than `size × price` (the limit price, or the slippage ceiling). A sell's
 * price is a FLOOR, so `size × price` could be made arbitrarily small; it is
 * valued at the higher of that and a real price: the book's own price for the
 * size, else the shared market data's mark.
 *
 * SEN-133: with neither, the sell is refused. Falling back to the floor alone
 * fails open: on an empty book an agent could dump its whole balance at
 * 0.0000001 and the cap would see almost nothing.
 */
async function orderNotional(
  ctx: ToolContext,
  venues: ToolVenues,
  id: ToolVenueId,
  args: { market: string; side: Side; size: Decimal },
  price: Decimal,
): Promise<Decimal> {
  const atPrice = mulDecimal(args.size, price);
  if (args.side === 'buy') return atPrice;
  const quote = await venueOf(venues, id).quote({
    symbol: args.market,
    side: 'sell',
    size: args.size,
  });
  const reference = isPositiveDecimal(quote.averagePrice)
    ? quote.averagePrice
    : await markOf(ctx, id, args.market);
  if (reference === undefined) {
    throw new SenteRefusal(
      'unpriced_sell',
      `the ${args.market} book has no bids and there is no mark price, so this sell cannot be ` +
        'valued against your order cap; your own floor price does not count as a valuation. ' +
        'Nothing was signed. Check get_depth and try again once the market has a price.',
    );
  }
  return maxDecimal(atPrice, mulDecimal(args.size, reference));
}

/**
 * The shared mark, or undefined when there is none. A failed read counts as
 * no price: the caller then refuses, so an outage can block a sell but never
 * let one through unvalued.
 */
async function markOf(
  ctx: ToolContext,
  id: ToolVenueId,
  symbol: string,
): Promise<Decimal | undefined> {
  if (!ctx.marketData) return undefined;
  try {
    const mark = await ctx.marketData.mark(id, symbol);
    return mark !== null && isPositiveDecimal(mark) ? mark : undefined;
  } catch {
    return undefined;
  }
}

function orderIntent(
  venues: ToolVenues,
  args: { venue: ToolVenueId; market: string; leverage?: number | undefined },
  notional: Decimal,
): Intent {
  return {
    venue: args.venue,
    kind: 'order',
    market: mandateMarket(venues, args.venue, args.market),
    notional,
    ...(args.leverage !== undefined ? { leverage: args.leverage } : {}),
  };
}

/**
 * Venue pre-flight for a Kuru order (SEN-19), run only with the pre-check on so
 * the enclave demo still reaches the enclave. Refuses what must revert anyway:
 * below the market's minimum notional, or more than AccountCore can back (a
 * buy locks quote at size x price; a sell locks base). On Monad a revert pays
 * the whole gas limit, so these checks save real MON.
 */
async function kuruOrderPreflight(
  kuru: KuruToolVenue,
  args: { market: string; side: Side; size: Decimal },
  price: Decimal,
): Promise<void> {
  const market = kuru.market(args.market);
  const notional = mulDecimal(args.size, price);
  const listed = (await kuru.getMarkets()).find((m) => m.symbol === args.market);
  if (listed?.minNotional && compareDecimal(notional, listed.minNotional) < 0) {
    throw new SenteRefusal(
      'below_min_notional',
      `Kuru's minimum order on ${args.market} is ${listed.minNotional} ${market.quote.symbol}; ` +
        `this one is ${notional}. Size it up, and make sure AccountCore can back it.`,
    );
  }
  const asset = args.side === 'buy' ? market.quote.symbol : market.base.symbol;
  const needed = args.side === 'buy' ? notional : args.size;
  const available = (await kuru.getBalances()).find((b) => b.asset === asset)?.available ?? '0';
  if (compareDecimal(available, needed) < 0) {
    throw new SenteRefusal(
      'insufficient_balance',
      `Your Kuru AccountCore has ${available} ${asset} available; this order needs ${needed}. ` +
        'Deposit first with the deposit tool (get_balances shows what your wallet holds). ' +
        'Nothing was signed.',
    );
  }
}

function spotOnlyChecks(args: {
  venue: ToolVenueId;
  leverage?: number | undefined;
  reduceOnly?: boolean | undefined;
}) {
  if (args.venue === 'kuru' && (args.leverage !== undefined || args.reduceOnly !== undefined)) {
    throw invalidInput('leverage and reduceOnly apply to Perpl only; Kuru is spot');
  }
}

function depositToken(kuru: KuruToolVenue, args: { market: string; asset: string }): KuruToken {
  let config;
  try {
    config = kuru.market(args.market);
  } catch {
    throw invalidInput(`Kuru does not list ${args.market}`);
  }
  const token = [config.base, config.quote].find((t) => t.symbol === args.asset);
  if (!token) {
    throw invalidInput(
      `${args.asset} is not traded on ${args.market}; deposit ${config.base.symbol} or ` +
        `${config.quote.symbol}`,
    );
  }
  return token;
}

function atoms(amount: Decimal, token: KuruToken): bigint {
  try {
    return toUnits(amount, token.decimals, 'amount');
  } catch (error) {
    throw invalidInput(error instanceof Error ? error.message : String(error));
  }
}

async function currentMandate(ctx: ToolContext): Promise<{ agent: AgentRecord; mandate: Mandate }> {
  const agent = (await ctx.currentAgent()) ?? ctx.agent;
  return { agent, mandate: agent.mandate };
}

const KURU_TOKENS = Object.values(KURU_TESTNET_TOKENS);

/**
 * The mandate as the model should read it: symbols and human amounts next to
 * the raw form. `get_mandate` returns it, and the runner's system prompt
 * renders it (SEN-8).
 */
export function describeMandate(agent: AgentRecord, now: number) {
  const { mandate } = agent;
  const retired = retiredKuruReferences(mandate);
  const kuruMarkets = mandate.kuru.markets.map((address) => ({
    symbol: KURU_TESTNET_MARKETS.find((m) => isAddressEqual(m.address, address))?.symbol,
    address,
  }));
  const kuruDeposits = Object.entries(mandate.kuru.maxDepositAtoms).map(([address, cap]) => {
    const token = KURU_TOKENS.find((t) => isAddressEqual(t.address, address as `0x${string}`));
    return {
      asset: token?.symbol ?? address,
      maxPerDeposit: token ? fromUnits(cap, token.decimals) : cap.toString(),
    };
  });
  return {
    agentId: agent.id,
    status: agent.status,
    expiresAt: new Date(mandate.expiresAt * 1000).toISOString(),
    secondsLeft: Math.max(0, mandate.expiresAt - now),
    venues: mandate.venues,
    maxOrderNotional: mandate.maxOrderNotional,
    kuru: { markets: kuruMarkets, deposits: kuruDeposits },
    // SEN-185: a mandate still naming Kuru's retired books cannot trade Kuru at all.
    ...(retired.length > 0 ? { kuruRetired: retiredKuruMessage(retired) } : {}),
    perpl: {
      markets: mandate.perpl.markets,
      maxLeverage: mandate.perpl.maxLeverage,
      maxCollateralAUSD: fromUnits(mandate.perpl.maxCollateralAtoms, PERPL_COLLATERAL_DECIMALS),
    },
    rules: [
      'Call record_thesis for a market before any place_limit, place_market or deposit on it.',
      'maxOrderNotional caps every single order in quote units: size x price (a market order ' +
        'at its slippage bound; a sell at no less than the book price).',
      'cancel_order and close_position are always allowed on a venue you may use.',
      'withdraw (Kuru collateral straight back to your owner) is always allowed on Kuru, even ' +
        'after the mandate expires.',
      'The Privy enclave independently refuses to sign anything outside the mandate.',
    ],
    raw: toMandateDto(mandate),
  };
}

// ---------------------------------------------------------------------------
// Read tools

const getMandate = defineTool({
  name: 'get_mandate',
  kind: 'read',
  description:
    'Your mandate: the only venues and markets you may trade, the largest order, the ' +
    'leverage and deposit caps, and when it expires. Anything outside it is refused. ' +
    'Call this first.',
  input: z.strictObject({}),
  async handler(ctx) {
    const { agent } = await currentMandate(ctx);
    return describeMandate(agent, ctx.now());
  },
});

const listMarkets = defineTool({
  name: 'list_markets',
  kind: 'read',
  description:
    'Markets on each venue, with tick size, step size and minimum size, and whether your ' +
    'mandate allows trading each one.',
  input: z.strictObject({ venue: venue.optional() }),
  async handler(ctx, args) {
    const [{ mandate }, venues] = await Promise.all([currentMandate(ctx), ctx.venues()]);
    const ids = args.venue ? [args.venue] : VENUE_IDS;
    return Promise.all(
      ids.map(async (id) => {
        const v = id === 'kuru' ? venues.kuru : venues.perpl;
        if (!v) return { venue: id, available: false, reason: 'Perpl is not set up yet' };
        const markets = await v.getMarkets();
        return {
          venue: id,
          available: true,
          venueAllowed: mandate.venues.includes(id),
          markets: markets.map((m) => ({
            ...m,
            allowed: marketAllowed(mandate, id, mandateMarket(venues, id, m.symbol)),
          })),
        };
      }),
    );
  },
});

/**
 * A shared market-data read, with the service's "you asked for something that
 * does not exist" errors turned into `invalid_input` (SEN-79): the model should
 * fix its arguments, not read them as the venue being down. `venue_unavailable`
 * stays a venue error.
 */
async function marketRead<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (
      error instanceof MarketNotFoundError ||
      error instanceof IntervalNotSupportedError ||
      error instanceof InvalidSizeError
    ) {
      throw invalidInput(error.message);
    }
    throw error;
  }
}

const getDepth = defineTool({
  name: 'get_depth',
  kind: 'read',
  description: 'The order book for one market: bids best first, asks best first.',
  input: z.strictObject({
    venue,
    market,
    limit: z.number().int().min(1).max(50).optional().describe('Levels per side; default 10.'),
  }),
  async handler(ctx, args) {
    const limit = args.limit ?? 10;
    // SEN-79: Perpl's adapter opens a fresh socket per `getDepth`, and every
    // run snapshots every allowed Perpl market, so it reads the shared held
    // book instead. Kuru's is one Gateway HTTP call and stays per-agent.
    const { marketData } = ctx;
    if (args.venue === 'perpl' && marketData) {
      return marketRead(() => marketData.depth('perpl', args.market, limit));
    }
    const v = venueOf(await ctx.venues(), args.venue);
    return v.getDepth({ symbol: args.market, limit });
  },
});

/**
 * The most recent candles of one market, oldest first: from the shared cached
 * read path when there is one, else from the agent's own venue. Perpl's 1w is
 * refused here, not left to the venue, so the model gets a fixable
 * invalid_input with or without the shared service behind it.
 */
function refuseUnsupportedInterval(venue: ToolVenueId, interval: KlineInterval): void {
  if (venue === 'perpl' && interval === '1w') {
    throw invalidInput('Perpl has no 1w candles; use 1d or shorter');
  }
}

async function readKlines(
  ctx: ToolContext,
  venue: ToolVenueId,
  symbol: string,
  interval: KlineInterval,
  limit: number,
): Promise<readonly (KlineDto | Kline)[]> {
  refuseUnsupportedInterval(venue, interval);
  const { marketData } = ctx;
  return marketData
    ? (await marketRead(() => marketData.klines(venue, symbol, interval, limit))).klines
    : venueOf(await ctx.venues(), venue).getKlines({ symbol, interval, limit });
}

const getKlines = defineTool({
  name: 'get_klines',
  kind: 'read',
  description:
    'Price candles (klines) for one market, oldest first: t is the open time (Unix ms), then ' +
    'open, high, low, close, and qv the quote-unit volume (null when the venue does not ' +
    'report it; volumes are estimates). Use them for ranges, averages and highs/lows over ' +
    'time. Perpl has no 1w candles.',
  input: z.strictObject({
    venue,
    market,
    interval: z.enum(KLINE_INTERVALS).describe('Candle width.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe('How many of the most recent candles; default 48.'),
  }),
  async handler(ctx, args) {
    const interval: KlineInterval = args.interval;
    const klines = await readKlines(ctx, args.venue, args.market, interval, args.limit ?? 48);
    return {
      interval,
      // Volumes are estimates on both venues (`KlinesDto.volumeIsEstimate`).
      volumeIsEstimate: true,
      // Short keys: a 48-candle answer is read on every run, so it is priced in tokens.
      candles: klines.map((k) => ({
        t: k.openTime,
        o: k.open,
        h: k.high,
        l: k.low,
        c: k.close,
        qv: k.quoteVolume ?? null,
      })),
    };
  },
});

const MAX_INDICATOR_TIMEFRAMES = 4;
const MAX_INDICATOR_SPECS = 8;
/** Also the watchers' lookback (SEN-182), so their candle reads share this tool's cache entries. */
export const DEFAULT_INDICATOR_LOOKBACK = 200;
const MAX_INDICATOR_LOOKBACK = 500;
const DEFAULT_INDICATOR_SERIES = 5;
const MAX_INDICATOR_SERIES = 20;
/** Without a tick size, the closes' own precision, up to this many places. */
const MAX_INFERRED_PRICE_DECIMALS = 8;

/**
 * Indicators read only markets the mandate lets the agent trade: they are
 * for deciding a trade, and the run's attention belongs there.
 */
async function requireMandateMarket(ctx: ToolContext, venue: ToolVenueId, symbol: string) {
  const { mandate } = await currentMandate(ctx);
  if (!mandate.venues.includes(venue)) {
    throw new SenteRefusal('venue_not_allowed', `your mandate does not include ${venue}`);
  }
  if (!symbolInMandate(mandate, venue, symbol)) {
    throw new SenteRefusal(
      'market_not_allowed',
      `${symbol} on ${venue} is not in your mandate; get_mandate lists the markets you may use`,
    );
  }
}

/**
 * Whether the mandate lets the agent use `symbol` on `venue`, by symbol. The
 * static Kuru table, not `mandateMarket`: that needs the agent's venues built,
 * and a read (or a watcher check) should not pay for that.
 */
export function symbolInMandate(mandate: Mandate, venue: ToolVenueId, symbol: string): boolean {
  const market =
    venue === 'kuru'
      ? (KURU_TESTNET_MARKETS.find((m) => m.symbol === symbol)?.address ?? symbol)
      : symbol;
  return marketAllowed(mandate, venue, market);
}

/** The market's tick precision, or undefined when the catalog cannot say. */
async function tickDecimals(
  ctx: ToolContext,
  venue: ToolVenueId,
  symbol: string,
): Promise<number | undefined> {
  try {
    const { marketData } = ctx;
    const tickSize = marketData
      ? (await marketData.market(venue, symbol)).tickSize
      : (await venueOf(await ctx.venues(), venue).getMarkets()).find((m) => m.symbol === symbol)
          ?.tickSize;
    return tickSize === undefined ? undefined : decimalsOf(tickSize);
  } catch {
    return undefined;
  }
}

export function toSourceCandle(k: KlineDto | Kline): SourceCandle {
  return {
    candle: {
      t: k.openTime,
      open: Number(k.open),
      high: Number(k.high),
      low: Number(k.low),
      close: Number(k.close),
      volume: Number(k.volume),
    },
    closeTime: k.closeTime,
    close: k.close,
  };
}

const getIndicators = defineTool({
  name: 'get_indicators',
  kind: 'read',
  description:
    'Technical indicators computed by Sente on one of your mandate markets, over one or more ' +
    'timeframes at once (e.g. ["1h","15m","5m"] for a triple screen). Use this instead of ' +
    'computing indicators from get_klines yourself. Each spec is {type, ...params}; every ' +
    'param is optional: sma/ema/wma {period=20}; macd {fast=12, slow=26, signal=9} → line, ' +
    'signal, histogram; rsi {period=14} (Wilder); stochastic {k=14, d=3, smooth=3} → k, d; ' +
    'atr {period=14} (Wilder); bollinger {period=20, stddev=2} → upper, middle, lower, ' +
    'percentB, bandwidth; vwap {} and obv {}, both anchored at the first candle of the ' +
    'window, not the session; adx {period=14} → adx, plusDi, minusDi; force_index ' +
    '{period=13} (Elder, EMA of Δclose × volume); elder_ray {period=13} → ema, bullPower, ' +
    'bearPower. Per timeframe: `last` is the candle every value is computed on (closed: ' +
    'false means it is still forming), `value` the latest, `series` the last few values ' +
    'oldest first, ending with that latest. An indicator without enough candles shows ' +
    'value null with how many it needs; warnings flag that, missing candles and a flat ' +
    'market. Prices are decimal strings to the tick plus two places; oscillators 0-100.',
  input: z.strictObject({
    venue,
    market,
    timeframes: z
      .array(z.enum(KLINE_INTERVALS))
      .min(1)
      .max(MAX_INDICATOR_TIMEFRAMES)
      .refine((list) => new Set(list).size === list.length, 'list each timeframe once')
      .describe(`Candle widths, 1 to ${MAX_INDICATOR_TIMEFRAMES}. Perpl has no 1w.`),
    indicators: z
      .array(indicatorSpec)
      .min(1)
      .max(MAX_INDICATOR_SPECS)
      .describe(`1 to ${MAX_INDICATOR_SPECS} specs, e.g. [{"type":"ema","period":13}].`),
    lookback: z
      .number()
      .int()
      .min(2)
      .max(MAX_INDICATOR_LOOKBACK)
      .optional()
      .describe(
        `Candles per timeframe to compute over; default ${DEFAULT_INDICATOR_LOOKBACK}. ` +
          'EMA-based values settle with more history.',
      ),
    series: z
      .number()
      .int()
      .min(1)
      .max(MAX_INDICATOR_SERIES)
      .optional()
      .describe(`Recent values per output; default ${DEFAULT_INDICATOR_SERIES}.`),
  }),
  async handler(ctx, args) {
    const specs = args.indicators.map(checkSpec);
    // Before the mandate check and any read, so a bad request costs nothing.
    for (const tf of args.timeframes) refuseUnsupportedInterval(args.venue, tf);
    await requireMandateMarket(ctx, args.venue, args.market);
    const lookback = args.lookback ?? DEFAULT_INDICATOR_LOOKBACK;
    const [ticks, ...frames] = await Promise.all([
      tickDecimals(ctx, args.venue, args.market),
      ...args.timeframes.map((tf) => readKlines(ctx, args.venue, args.market, tf, lookback)),
    ]);
    const priceDecimals =
      ticks ??
      Math.min(
        MAX_INFERRED_PRICE_DECIMALS,
        Math.max(0, ...frames.flat().map((k) => decimalsOf(k.close))),
      );
    const nowMs = ctx.now() * 1000;
    const timeframes = Object.fromEntries(
      args.timeframes.map((tf, i) => [
        tf,
        summarize(frames[i]!.map(toSourceCandle), specs, {
          seriesLength: args.series ?? DEFAULT_INDICATOR_SERIES,
          priceDecimals,
          widthMs: KLINE_WIDTH_MS[tf],
          nowMs,
        }),
      ]),
    );
    return { venue: args.venue, market: args.market, timeframes };
  },
});

/** Funding rates arrive as fractions with at most 6 places on Perpl; 18 keeps any venue's exact. */
const RATE_DECIMALS = 18;
/** The per-8h figure is a ratio of two intervals, so it cannot always be exact; 8 places is plenty. */
const PER_8H_DECIMALS = 8;
const EIGHT_HOURS_SEC = 8n * 3600n;

type TickerFunding = { rate: Decimal; intervalHours: number } | null;

/** A funding rate as exact scaled integers; null when there is none to read. */
function scaledFunding(funding: TickerFunding) {
  const intervalSec = funding ? BigInt(Math.round(funding.intervalHours * 3600)) : 0n;
  if (funding === null || intervalSec <= 0n) return null;
  const rate = toScaled(funding.rate, RATE_DECIMALS, 'floor');
  const per8h = divRound(
    rate * 100n * EIGHT_HOURS_SEC * 10n ** BigInt(PER_8H_DECIMALS),
    intervalSec * 10n ** BigInt(RATE_DECIMALS),
  );
  return { rate, intervalSec, per8h };
}

/**
 * `get_funding`'s `ratePctPer8h`, exactly as the tool reports it, or null.
 * The watchers compare against this (SEN-182), so a threshold the agent took
 * from the tool means the same number.
 */
export function fundingPctPer8h(funding: TickerFunding): Decimal | null {
  const scaled = scaledFunding(funding);
  return scaled === null ? null : fromScaled(scaled.per8h, PER_8H_DECIMALS);
}

const getFunding = defineTool({
  name: 'get_funding',
  kind: 'read',
  description:
    'The latest funding rate of one Perpl perp. ratePctPer8h is that rate as a % per 8 hours ' +
    '(rounded to 8 places); positive means longs pay shorts, negative means shorts pay longs, ' +
    'and payer says it in words. ratePct and intervalMinutes are the raw per-interval figures. ' +
    'nextAt (Unix ms) is an estimate: Perpl counts the interval in blocks.',
  input: z.strictObject({
    market: market.describe('Perpl market symbol, e.g. "BTC-PERP".'),
  }),
  async handler(ctx, args) {
    // SEN-145: from the shared ticker, whose funding rides the cached
    // `/pub/context`, so a run's read costs Perpl nothing. There is no
    // per-agent fallback: the venue adapter has no funding read.
    const { marketData } = ctx;
    if (!marketData) {
      throw new VenueUnavailableError('funding is not available in this session');
    }
    const ticker = await marketRead(() => marketData.ticker('perpl', args.market));
    const scaled = scaledFunding(ticker.funding);
    if (scaled === null) {
      // A null the model must read as "no rate", never as a zero rate.
      return {
        market: ticker.symbol,
        funding: null,
        reason: `Perpl has published no funding for ${ticker.symbol} yet`,
      };
    }
    const { rate, intervalSec, per8h } = scaled;
    return {
      market: ticker.symbol,
      payer: rate === 0n ? 'nobody pays' : rate > 0n ? 'longs pay shorts' : 'shorts pay longs',
      ratePctPer8h: fromScaled(per8h, PER_8H_DECIMALS),
      ratePct: fromScaled(rate * 100n, RATE_DECIMALS),
      intervalMinutes: Number(intervalSec) / 60,
      nextAt: ticker.funding!.nextAt,
      stale: ticker.stale,
    };
  },
});

const MAX_QUOTE_SLIPPAGE = '0.05';
const DEFAULT_QUOTE_SLIPPAGE = '0.005';

const quoteOrder = defineTool({
  name: 'quote',
  kind: 'read',
  description:
    'What a market order of this size would get right now, walked against the live book: ' +
    'fillable size, average price, notional, fee, slippage against mid, and worstPrice, the ' +
    'bound for your maxSlippage. Pass worstPrice as slippageLimitPrice to place_market. If ' +
    'partial is true, only fillableWithinWorstPrice would fill and the rest is cancelled.',
  input: z.strictObject({
    venue,
    market,
    side,
    size: positive.describe('Base units, e.g. "0.5".'),
    maxSlippage: decimal
      .refine((v) => compareDecimal(v, MAX_QUOTE_SLIPPAGE) <= 0, `at most ${MAX_QUOTE_SLIPPAGE}`)
      .optional()
      .describe(
        `Fraction of the best price you accept moving through, e.g. "0.005" for 0.5%; ` +
          `default ${DEFAULT_QUOTE_SLIPPAGE}, at most ${MAX_QUOTE_SLIPPAGE}.`,
      ),
  }),
  async handler(ctx, args) {
    const { marketData } = ctx;
    const maxSlippage = args.maxSlippage ?? DEFAULT_QUOTE_SLIPPAGE;
    if (marketData) {
      return marketRead(() =>
        marketData.quote(args.venue, args.market, {
          side: args.side,
          size: args.size,
          maxSlippage,
        }),
      );
    }
    // Without the shared service there is no slippage bound to report: the
    // venue's own quote is the book walk alone.
    return venueOf(await ctx.venues(), args.venue).quote({
      symbol: args.market,
      side: args.side,
      size: args.size,
    });
  },
});

const getBalances = defineTool({
  name: 'get_balances',
  kind: 'read',
  description:
    'Your balances at each venue. Kuru: `balances` is your AccountCore account (available, and ' +
    'locked by resting orders), which is what orders use; `wallet` is what your wallet holds, ' +
    'which you can move into AccountCore with the deposit tool. Perpl: collateral.',
  input: z.strictObject({ venue: venue.optional() }),
  async handler(ctx, args) {
    const venues = await ctx.venues();
    const ids = args.venue ? [args.venue] : VENUE_IDS;
    return Promise.all(
      ids.map(async (id) => {
        const v = id === 'kuru' ? venues.kuru : venues.perpl;
        if (!v) return { venue: id, available: false, reason: 'Perpl is not set up yet' };
        if (id === 'kuru') {
          const [balances, wallet] = await Promise.all([
            venues.kuru.getBalances(),
            venues.kuru.walletBalances(),
          ]);
          return { venue: id, available: true, balances, wallet };
        }
        return { venue: id, available: true, balances: await v.getBalances() };
      }),
    );
  },
});

const getPositions = defineTool({
  name: 'get_positions',
  kind: 'read',
  description: 'Your open Perpl positions, optionally for one market.',
  input: z.strictObject({ market: market.optional() }),
  async handler(ctx, args) {
    return requirePerpl(await ctx.venues()).getPositions(args.market);
  },
});

const getOpenOrders = defineTool({
  name: 'get_open_orders',
  kind: 'read',
  description: 'Your orders still working on one venue, optionally for one market.',
  input: z.strictObject({ venue, market: market.optional() }),
  async handler(ctx, args) {
    return venueOf(await ctx.venues(), args.venue).getOpenOrders(args.market);
  },
});

/**
 * Nansen smart-money read (SEN-29). One client for the process, built on first
 * use so it sees the boot-time environment (Nest's ConfigModule loads `.env`
 * after module imports), and so its 10-minute cache outlives a single run:
 * the free plan gives 100 credits and then ~10 a day, and a fresh client per
 * run would spend the budget inside a few agents. With `NANSEN_API_KEY`
 * absent the tool answers `not_configured` — a real result, not a failure.
 */
let nansenClientSingleton: NansenClient | undefined;
function nansenClient(): NansenClient {
  nansenClientSingleton ??= new NansenClient();
  return nansenClientSingleton;
}

const smartMoneySignals = defineTool({
  name: 'smart_money_signals',
  kind: 'read',
  description:
    'Nansen Smart Money on the token behind one market over the last 24 hours: net flow ' +
    'in USD (accumulating or distributing), how many smart-money wallets traded it, and ' +
    'their DEX buys vs sells. This is MONAD MAINNET data used as context for your TESTNET ' +
    'trades — it describes the real market, not the book you trade on. A not_configured or ' +
    'unavailable result means there is no signal: trade on the venue data you have.',
  input: z.strictObject({ market }),
  async handler(_ctx, args) {
    return fetchSmartMoneySignals(nansenClient(), args.market);
  },
});

// ---------------------------------------------------------------------------
// Watchers (SEN-182): conditions Sente checks between runs without the model.

function requireWatchers(ctx: ToolContext) {
  if (!ctx.watchers) throw new VenueUnavailableError('watchers are not available in this session');
  return ctx.watchers;
}

/** A watcher as the model reads it back: the condition in words, and its history. */
function watcherSummary(view: WatcherSetView) {
  return {
    heartbeatHours: view.heartbeatSeconds / 3_600,
    watchers: view.watchers.map((w) => ({
      id: w.id,
      label: w.label,
      reads: w.reads,
      cooldownMinutes: w.cooldownMinutes,
      setBy: w.setBy,
      fireCount: w.fireCount,
      lastFiredAt: w.lastFiredAt,
      ...(w.lastError ? { lastError: w.lastError } : {}),
    })),
  };
}

function watcherRefusal(error: unknown): never {
  if (error instanceof WatcherInvalidError) throw new SenteRefusal(error.code, error.message);
  throw error;
}

const listWatchers = defineTool({
  name: 'list_watchers',
  kind: 'read',
  description:
    'Your watchers: the conditions Sente checks for you between runs without calling you, ' +
    'each in words, with how often it has fired.',
  input: z.strictObject({}),
  async handler(ctx) {
    return watcherSummary(requireWatchers(ctx).view(ctx.agent.id));
  },
});

const setWatchers = defineTool({
  name: 'set_watchers',
  kind: 'write',
  signs: false,
  description:
    'Replace your watchers. Between runs Sente checks them on your schedule WITHOUT calling ' +
    'you, and starts a run only when one fires (or after heartbeatHours with no run, default ' +
    '4), telling you which fired and what it saw. Without watchers you are run on every ' +
    `scheduled tick. Up to ${MAX_WATCHERS} watchers of up to ${MAX_CLAUSES} clauses, joined by ` +
    'match "all" (default) or "any"; mandate markets only. Clause types: ' +
    'price {venue, market, source "mark"|"last", op above|below|crosses_above|crosses_below, ' +
    'value}; price_band {venue, market, source, op inside|outside|enters|leaves, low, high}; ' +
    'indicator {venue, market, timeframe, indicator (a get_indicators spec), output (e.g. ' +
    '"line"; omit for one-value indicators), op, then value OR compareTo {indicator?, output}} ' +
    '— e.g. macd line crosses_above compareTo {output:"signal"}; position {market (Perpl), op ' +
    'pnl_above|pnl_below (value = % of margin)|opened|closed}; funding {market (Perpl), op ' +
    'above|below, value = % per 8h}. crosses_*, enters, leaves, opened and closed fire once on ' +
    'the flip; the others fire while true, at most once per cooldownMinutes (default 60). ' +
    "Pass a watcher's id back to keep its state. An empty list removes them all.",
  input: watcherSetInput,
  async handler(ctx, args) {
    const watchers = requireWatchers(ctx);
    const { agent } = await currentMandate(ctx);
    try {
      watchers.replace(agent, args, 'agent');
    } catch (error) {
      watcherRefusal(error);
    }
    return { set: args.watchers.length, ...watcherSummary(watchers.view(agent.id)) };
  },
});

const clearWatchers = defineTool({
  name: 'clear_watchers',
  kind: 'write',
  signs: false,
  description:
    'Remove all your watchers. You are then run on every scheduled tick again, as before ' +
    'you set any.',
  input: z.strictObject({}),
  async handler(ctx) {
    const watchers = requireWatchers(ctx);
    const cleared = watchers.view(ctx.agent.id).watchers.length;
    watchers.clear(ctx.agent.id);
    return { cleared };
  },
});

// ---------------------------------------------------------------------------
// Write tools

const recordThesis = defineTool({
  name: 'record_thesis',
  kind: 'write',
  signs: false,
  description:
    'Write down why you are about to trade a market and what would prove you wrong. Required ' +
    'before any place_limit, place_market or deposit on that market in this run. Recording ' +
    'again replaces your thesis for that market.',
  input: z.strictObject({
    market,
    direction: z.enum(['long', 'short']),
    thesis: z.string().min(1).max(2000).describe('Why this trade, now.'),
    invalidation: z
      .string()
      .min(1)
      .max(1000)
      .describe('What would prove the thesis wrong, and what you will do then.'),
  }),
  async handler(ctx, args) {
    const recorded = { ...args, at: Date.now() };
    ctx.theses.set(args.market, recorded);
    await ctx.events.append({
      agentId: ctx.agent.id,
      runId: ctx.runId,
      kind: 'thesis',
      tool: 'record_thesis',
      detail: recorded,
    });
    return { recorded: true, market: args.market, direction: args.direction };
  },
});

const placeLimit = defineTool({
  name: 'place_limit',
  kind: 'write',
  description:
    'Place a limit order. Its notional (size x price) must be within your mandate. On Perpl, ' +
    'leverage is required.',
  input: z.strictObject({
    venue,
    market,
    side,
    size: positive.describe('Base units, e.g. "0.5".'),
    price: positive.describe('Limit price in quote units, on the market tick.'),
    timeInForce: z.enum(['GTC', 'IOC', 'FOK', 'POST_ONLY']).optional(),
    leverage: leverage.optional(),
    reduceOnly: reduceOnly.optional(),
    clientOrderId: clientOrderId.optional(),
  }),
  thesisMarket: (args) => args.market,
  async intent(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    return orderIntent(
      venues,
      args,
      await orderNotional(ctx, venues, args.venue, args, args.price),
    );
  },
  async handler(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    const request = {
      symbol: args.market,
      side: args.side,
      size: args.size,
      price: args.price,
      timeInForce: args.timeInForce,
      reduceOnly: args.reduceOnly,
      clientOrderId: args.clientOrderId,
    };
    if (args.venue === 'kuru') {
      if (ctx.precheck) await kuruOrderPreflight(venues.kuru, args, args.price);
      return venues.kuru.placeLimit(request);
    }
    const perpl = requirePerpl(venues);
    if (args.leverage !== undefined) {
      await perpl.setLeverage({ symbol: args.market, leverage: args.leverage });
    }
    return perpl.placeLimit(request);
  },
});

const placeMarket = defineTool({
  name: 'place_market',
  kind: 'write',
  description:
    'Place a market order that fills now or not at all, bounded by slippageLimitPrice: the ' +
    'worst price you accept (a ceiling for a buy, a floor for a sell). The bound is required. ' +
    'On Perpl, leverage is required.',
  input: z.strictObject({
    venue,
    market,
    side,
    size: positive.describe('Base units, e.g. "0.5".'),
    slippageLimitPrice: positive.describe('Worst acceptable execution price. Required.'),
    leverage: leverage.optional(),
    reduceOnly: reduceOnly.optional(),
    clientOrderId: clientOrderId.optional(),
  }),
  thesisMarket: (args) => args.market,
  async intent(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    const notional = await orderNotional(ctx, venues, args.venue, args, args.slippageLimitPrice);
    return orderIntent(venues, args, notional);
  },
  async handler(ctx, args) {
    spotOnlyChecks(args);
    const venues = await ctx.venues();
    const request = {
      symbol: args.market,
      side: args.side,
      size: args.size,
      slippageLimitPrice: args.slippageLimitPrice,
      reduceOnly: args.reduceOnly,
      clientOrderId: args.clientOrderId,
    };
    if (args.venue === 'kuru') {
      if (ctx.precheck) await kuruOrderPreflight(venues.kuru, args, args.slippageLimitPrice);
      return venues.kuru.placeMarket(request);
    }
    const perpl = requirePerpl(venues);
    if (args.leverage !== undefined) {
      await perpl.setLeverage({ symbol: args.market, leverage: args.leverage });
    }
    return perpl.placeMarket(request);
  },
});

const deposit = defineTool({
  name: 'deposit',
  kind: 'write',
  description:
    'Move funds from your wallet into your Kuru AccountCore balance, so orders on a Kuru ' +
    'market can use them. Within the per-deposit cap of your mandate.',
  input: z.strictObject({
    market: market.describe('The Kuru market this deposit funds, e.g. "MON-USDC".'),
    asset: z
      .string()
      .min(1)
      .max(16)
      .describe('The token: that market\'s base or quote, e.g. "USDC".'),
    amount: positive.describe('Human units, e.g. "25" for 25 USDC.'),
  }),
  thesisMarket: (args) => args.market,
  async intent(ctx, args) {
    const { kuru } = await ctx.venues();
    const token = depositToken(kuru, args);
    return {
      venue: 'kuru',
      kind: 'deposit',
      market: token.address,
      amountAtoms: atoms(args.amount, token),
    };
  },
  async handler(ctx, args) {
    const { kuru } = await ctx.venues();
    const token = depositToken(kuru, args);
    atoms(args.amount, token); // precision, before anything is signed
    if (ctx.precheck) {
      const held = (await kuru.walletBalances()).find((b) => b.asset === token.symbol)?.available;
      if (compareDecimal(held ?? '0', args.amount) < 0) {
        throw new SenteRefusal(
          'insufficient_balance',
          `Your wallet holds ${held ?? '0'} ${token.symbol}; you can deposit at most that. ` +
            'Nothing was signed.',
        );
      }
    }
    const execution = await kuru.deposit(token.symbol, args.amount);
    return {
      deposited: args.amount,
      asset: token.symbol,
      hash: execution.hash,
      transactionHash: execution.transactionHash,
    };
  },
});

function kuruToken(asset: string): KuruToken {
  const token = KURU_TOKENS.find((t) => t.symbol === asset);
  if (!token) {
    throw invalidInput(
      `Kuru has no asset ${asset}; withdraw one of ${KURU_TOKENS.map((t) => t.symbol).join(', ')}`,
    );
  }
  return token;
}

const withdraw = defineTool({
  name: 'withdraw',
  kind: 'write',
  description:
    'Move free funds out of your Kuru AccountCore balance, straight back to your owner’s ' +
    'wallet. Always allowed on Kuru, even after your mandate expires, with no thesis needed: ' +
    'taking collateral off the venue reduces risk. Funds reserved by resting orders stay until ' +
    'you cancel them. The money can only ever go to your owner — it leaves your capital.',
  input: z.strictObject({
    asset: z.string().min(1).max(16).describe('The token, e.g. "USDC".'),
    amount: positive.describe('Human units, e.g. "14" for 14 USDC.'),
  }),
  async intent(_ctx, args) {
    const token = kuruToken(args.asset);
    return {
      venue: 'kuru',
      kind: 'withdraw',
      market: token.address,
      amountAtoms: atoms(args.amount, token),
    };
  },
  async handler(ctx, args) {
    const token = kuruToken(args.asset);
    atoms(args.amount, token); // precision, before anything is signed
    // The policy pins `withdraw.recipient` to the owner's `returnTo` (SEN-185):
    // AccountCore pays whoever the call names, so no other address is signable.
    const agent = (await ctx.currentAgent()) ?? ctx.agent;
    const returnTo = agent.mandate.returnTo;
    if (!returnTo) {
      throw invalidInput(
        'your mandate names no owner wallet to return funds to, so Kuru has nowhere it may pay; ' +
          'your owner must amend the mandate first',
      );
    }
    const { kuru } = await ctx.venues();
    const execution = await kuru.withdraw(token.symbol, args.amount, returnTo);
    return {
      withdrawn: args.amount,
      asset: token.symbol,
      hash: execution.hash,
      transactionHash: execution.transactionHash,
    };
  },
});

const cancelOrder = defineTool({
  name: 'cancel_order',
  kind: 'write',
  description:
    'Cancel one of your resting orders. Always allowed, with no thesis needed: reducing risk ' +
    'is never blocked. Cancelling an order that already finished reports how it ended.',
  input: z.strictObject({
    venue,
    market,
    orderId: z.string().min(1).max(100).describe('The id returned when the order was placed.'),
  }),
  async intent(ctx, args) {
    const venues = await ctx.venues();
    return {
      venue: args.venue,
      kind: 'cancel',
      market: mandateMarket(venues, args.venue, args.market),
    };
  },
  async handler(ctx, args) {
    return venueOf(await ctx.venues(), args.venue).cancel({
      symbol: args.market,
      orderId: args.orderId,
    });
  },
});

const closePosition = defineTool({
  name: 'close_position',
  kind: 'write',
  description:
    'Close a Perpl position, fully or partly, with a reduce-only order that can never flip it. ' +
    'Always allowed, with no thesis needed.',
  input: z.strictObject({
    market,
    size: positive.optional().describe('Base units to close; omit to close all of it.'),
    slippageLimitPrice: positive
      .optional()
      .describe('Worst acceptable price; omit for the venue default bound.'),
  }),
  async intent(_ctx, args) {
    return { venue: 'perpl', kind: 'close', market: args.market };
  },
  async handler(ctx, args) {
    return requirePerpl(await ctx.venues()).closePosition({
      symbol: args.market,
      size: args.size,
      slippageLimitPrice: args.slippageLimitPrice,
    });
  },
});

/** Every tool, reads first. */
export const AGENT_TOOLS: readonly AgentTool[] = [
  getMandate,
  listMarkets,
  getDepth,
  getKlines,
  getIndicators,
  getFunding,
  quoteOrder,
  getBalances,
  getPositions,
  getOpenOrders,
  smartMoneySignals,
  listWatchers,
  setWatchers,
  clearWatchers,
  recordThesis,
  placeLimit,
  placeMarket,
  deposit,
  withdraw,
  cancelOrder,
  closePosition,
];
