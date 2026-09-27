/**
 * What the asset page prints (SEN-112, plan U-6; the study's `markets.html` →
 * "Spot asset: MON on Kuru" and "Perp asset: ETH-PERP on Perpl"): the header
 * for spot vs perp, the range pills and the klines each one asks for, the
 * scrub-bound headline, the change grid, the market stats, funding, the book
 * pressure and the agents that may trade the market. Plain node, no React
 * Native, so `asset.test.ts` runs without a device; the screen only lays out.
 *
 * Prices stay decimal strings; only display-only ratios (a change, a spread's
 * percent, a pressure split) go through a float.
 */
import type { Agent, AgentPortfolioDto } from '../agents/api.ts';
import { marketFor } from '../agents/mandate.ts';
import { formatPrice as formatPlaces, priceDecimals } from '../ui/chart/geometry.ts';
import { formatPrice, pctChange } from '../ui/tradingFormat.ts';

import type {
  Decimal,
  DepthDto,
  KlineDto,
  KlineInterval,
  MarketDto,
  TickerDto,
  VenueId,
} from './api.ts';

const MINUS = '−';
const VENUE_NAME: Record<VenueId, string> = { kuru: 'Kuru', perpl: 'Perpl' };

/** The `[venue]` route segment, or `null` for anything we don't list. */
export function parseVenue(raw: string | string[] | undefined): VenueId | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value === 'kuru' || value === 'perpl' ? value : null;
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

export type AssetHeader = {
  /** `MON`, `ETH`: the base, with the PERP tag beside it for a perp. */
  title: string;
  /** `MON-USDC · Kuru spot`, `ETH-AUSD · Perpl perps`: the quote is always named. */
  caption: string;
  /** Every figure on the page is in this currency; Kuru USDC and Perpl AUSD never mix. */
  unit: MarketDto['quote'];
  perp: boolean;
  /** The sticky pair, sell side first: `Sell`/`Buy` or `Short`/`Long`. */
  actions: readonly [string, string];
};

export function assetHeader(market: MarketDto): AssetHeader {
  const perp = market.kind === 'perp';
  const venue = VENUE_NAME[market.venue];
  return {
    title: market.base,
    caption: `${market.base}-${market.quote} · ${venue} ${perp ? 'perps' : 'spot'}`,
    unit: market.quote,
    perp,
    actions: perp ? ['Short', 'Long'] : ['Sell', 'Buy'],
  };
}

/** Decimals the market quotes: the tick's, else the chart's rule for the price. */
export function placesFor(market: MarketDto, price: Decimal | null): number {
  const fraction = /\.(\d*?)0*$/.exec(market.tickSize.trim())?.[1];
  if (fraction !== undefined) return fraction.length;
  if (/^\d+$/.test(market.tickSize.trim())) return 0;
  return priceDecimals(Number(price ?? 0));
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------

export type AssetRange = '1H' | '1D' | '1W' | '1M' | '1Y';
export type ChartKind = 'line' | 'candles';

/**
 * Each range as one klines request. Perps skip 1Y: Perpl serves at most 1,024
 * candles and no weekly interval, so a year would be a squashed daily series
 * the venue may not even have.
 */
const RANGE_QUERY: Record<AssetRange, { interval: KlineInterval; limit: number }> = {
  '1H': { interval: '1m', limit: 60 },
  '1D': { interval: '15m', limit: 96 },
  '1W': { interval: '1h', limit: 168 },
  '1M': { interval: '4h', limit: 180 },
  '1Y': { interval: '1d', limit: 365 },
};

const SPOT_RANGES: readonly AssetRange[] = ['1H', '1D', '1W', '1M', '1Y'];
const PERP_RANGES: readonly AssetRange[] = ['1H', '1D', '1W', '1M'];

export function rangesFor(market: MarketDto): readonly AssetRange[] {
  return market.kind === 'perp' ? PERP_RANGES : SPOT_RANGES;
}

export function rangeQuery(range: AssetRange): { interval: KlineInterval; limit: number } {
  return RANGE_QUERY[range];
}

/**
 * Where the page opens: a spot pair on a week of line (holders ask "how's it
 * doing"), a perp on a day of candles (traders ask "where's it going now").
 */
export function defaultView(market: MarketDto): { range: AssetRange; kind: ChartKind } {
  return market.kind === 'perp' ? { range: '1D', kind: 'candles' } : { range: '1W', kind: 'line' };
}

const RANGE_SUFFIX: Record<AssetRange, string> = {
  '1H': ' past hour',
  '1D': ' today',
  '1W': ' past week',
  '1M': ' past month',
  '1Y': ' past year',
};

// ---------------------------------------------------------------------------
// Price and headline
// ---------------------------------------------------------------------------

/** The live price: the last trade, else the perp's mark, else the mid. */
export function livePrice(ticker: TickerDto | null): Decimal | null {
  if (ticker === null) return null;
  return ticker.last ?? ticker.mark ?? ticker.mid ?? null;
}

/**
 * The line's points: closes, with the last replaced by the live price. The
 * last candle is still open and klines poll slower than the ticker, so the
 * swap keeps the line's end on the number printed above it.
 */
export function linePoints(klines: readonly KlineDto[], live: Decimal | null): Decimal[] {
  const closes = klines.map((kline) => kline.close);
  if (live !== null && closes.length > 0) closes[closes.length - 1] = live;
  return closes;
}

/** Where the window starts: the first candle's open. The chart's dashed prev-close. */
export function windowBase(klines: readonly KlineDto[]): Decimal | null {
  return klines[0]?.open ?? null;
}

export type Headline = {
  price: Decimal | null;
  /** Percent over the window, e.g. `2.41`; `null` without a base. */
  pct: number | null;
  /** ` past week`, or while scrubbing the candle's time (` at Sep 23, 14:05`). */
  suffix: string;
  /** Set while scrubbing: the open time of the candle under the finger. */
  at: number | null;
};

/**
 * The big number and its change, written from the chart's scrub so the two
 * can't disagree (the chart never owns the headline). Not scrubbing, it is the
 * live price against the window's start; scrubbing, that candle's close.
 */
export function headline(
  klines: readonly KlineDto[],
  live: Decimal | null,
  range: AssetRange,
  scrub: number | null,
): Headline {
  const base = windowBase(klines);
  const scrubbed = scrub === null ? undefined : klines[scrub];
  const price =
    scrubbed !== undefined ? scrubbed.close : (live ?? klines[klines.length - 1]?.close ?? null);
  return {
    price,
    pct: base !== null && price !== null ? pctChange(base, price) : null,
    suffix: scrubbed !== undefined ? scrubTime(scrubbed.openTime, range) : RANGE_SUFFIX[range],
    at: scrubbed !== undefined ? scrubbed.openTime : null,
  };
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * What replaces ` past week` while scrubbing: when the candle under the finger
 * opened, in local time. Intraday ranges need only the clock, longer ones the
 * day too, and a year no clock at all.
 */
export function scrubTime(ms: number, range: AssetRange): string {
  const d = new Date(ms);
  const clock = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (range === '1H') return ` at ${clock}`;
  if (range === '1Y') return ` on ${day}`;
  return ` at ${day}, ${clock}`;
}

// ---------------------------------------------------------------------------
// Change grid
// ---------------------------------------------------------------------------

export type ChangeCell = { label: string; pct: number | null; primary: boolean };

/** The klines the grid reads: a day of 5-minute candles covers all four horizons. */
export const GRID_QUERY: { interval: KlineInterval; limit: number } = {
  interval: '5m',
  limit: 289,
};

const MINUTE = 60_000;
const HORIZONS = [
  { label: '5M', ms: 5 * MINUTE },
  { label: '1H', ms: 60 * MINUTE },
  { label: '4H', ms: 240 * MINUTE },
  { label: '1D', ms: 1_440 * MINUTE },
] as const;

/**
 * "How's it doing" at four horizons without switching range. Each cell is the
 * live price against the open of the first candle inside the horizon; a
 * horizon the candles don't reach back to is a dash, not a shorter window
 * passed off as the longer one.
 *
 * 1D is the primary cell and prefers the ticker's own 24h change: it is the
 * number the Markets list and Home show, and the grid must not print another.
 */
export function changeGrid(
  klines: readonly KlineDto[],
  live: Decimal | null,
  ticker: TickerDto | null,
): ChangeCell[] {
  const last = klines[klines.length - 1];
  const price = live ?? last?.close ?? null;
  return HORIZONS.map(({ label, ms }) => {
    const primary = label === '1D';
    if (primary && ticker?.change24hPct != null) {
      const fraction = Number(ticker.change24hPct);
      if (Number.isFinite(fraction)) return { label, pct: fraction * 100, primary };
    }
    if (last === undefined || price === null) return { label, pct: null, primary };
    const since = last.closeTime - ms;
    const first = klines[0]!;
    if (first.openTime > since + 1) return { label, pct: null, primary };
    const from = klines.find((kline) => kline.openTime >= since) ?? last;
    return { label, pct: pctChange(from.open, price), primary };
  });
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export type StatRow = { label: string; value: string };

/**
 * The Market rows. Volume is quote-denominated because that's what both
 * venues report; Kuru's minimum is a notional (it enforces min notional, not
 * size). A figure the venue didn't send is left out, never printed as zero.
 */
export function statRows(market: MarketDto, ticker: TickerDto | null): StatRow[] {
  const rows: StatRow[] = [];
  const unit = market.quote;
  if (ticker?.low24h && ticker.high24h) {
    const low = formatPrice(ticker.low24h, market.tickSize);
    const high = formatPrice(ticker.high24h, market.tickSize);
    if (low && high) rows.push({ label: '24h range', value: `${low} – ${high}` });
  }
  if (ticker?.quoteVolume24h) {
    const volume = compactAmount(ticker.quoteVolume24h);
    if (volume) rows.push({ label: '24h volume', value: `${volume} ${unit}` });
  }
  const spread = ticker ? spreadLabel(ticker.bid, ticker.ask, market.tickSize) : null;
  if (spread) rows.push({ label: 'Spread', value: spread });
  if (market.kind === 'perp') {
    if (market.maxLeverage) rows.push({ label: 'Max leverage', value: `${market.maxLeverage}×` });
    if (market.marginMode === 'isolated') rows.push({ label: 'Margin', value: 'Isolated' });
  } else if (market.minNotional) {
    rows.push({ label: 'Min order', value: `${formatPlaces(market.minNotional, 2)} ${unit}` });
  } else {
    rows.push({ label: 'Min order', value: `${market.minSize} ${market.base}` });
  }
  const fee = feeLabel(market.takerFee);
  if (fee) rows.push({ label: 'Taker fee', value: fee });
  return rows;
}

/** `0.0004 (0.04%)`: the gap on the tick grid, and as a share of the mid. */
export function spreadLabel(
  bid: Decimal | null,
  ask: Decimal | null,
  tick: Decimal,
): string | null {
  if (bid === null || ask === null) return null;
  const b = Number(bid);
  const a = Number(ask);
  if (!Number.isFinite(a) || !Number.isFinite(b) || a < b || a + b === 0) return null;
  // A float difference is fine here: `formatPrice` re-rounds it onto the tick.
  // `toFixed`, not `String`: a tiny gap would print in exponent form.
  const gap = formatPrice((a - b).toFixed(12), tick);
  if (gap === null) return null;
  return `${gap} (${(((a - b) / ((a + b) / 2)) * 100).toFixed(2)}%)`;
}

/** `0.0007` → `0.07%`. */
export function feeLabel(fraction: Decimal): string | null {
  const value = Number(fraction);
  if (!Number.isFinite(value)) return null;
  return `${Number((value * 100).toFixed(4))}%`;
}

/** `184,210` under a million, `41.2M` and `1.3B` above: a stat row, not a statement. */
export function compactAmount(value: Decimal): string | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  if (Math.abs(n) >= 1e9) return `${Number((n / 1e9).toFixed(1))}B`;
  if (Math.abs(n) >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`;
  return formatPlaces(value, 0);
}

// ---------------------------------------------------------------------------
// Funding (perps)
// ---------------------------------------------------------------------------

export type FundingView = {
  /** Who pays, in words first: `longs pay shorts`. */
  payer: string;
  /** `+0.0100% / 8h`. */
  rate: string;
  /** `3h 12m`, or `null` when the venue didn't say. */
  nextIn: string | null;
};

export function fundingView(funding: TickerDto['funding'], now: number): FundingView | null {
  if (funding === null) return null;
  const rate = Number(funding.rate);
  if (!Number.isFinite(rate)) return null;
  const pct = Math.abs(rate * 100).toFixed(4);
  const payer =
    Number(pct) === 0 ? 'nobody pays' : rate > 0 ? 'longs pay shorts' : 'shorts pay longs';
  const sign = Number(pct) === 0 ? '' : rate > 0 ? '+' : MINUS;
  return {
    payer,
    rate: `${sign}${pct}% / ${funding.intervalHours}h`,
    nextIn: funding.nextAt === null ? null : countdown(funding.nextAt, now),
  };
}

/** `3h 12m`, `12m`, `under 1m`. */
export function countdown(at: number, now: number): string {
  const minutes = Math.floor((at - now) / MINUTE);
  if (minutes < 1) return 'under 1m';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// Book pressure
// ---------------------------------------------------------------------------

/** How many levels a side the pressure bar sums; the study's "top 10 levels". */
export const PRESSURE_LEVELS = 10;

/**
 * Resting size on each side over the top `levels`, in base units, as decimal
 * strings for `PressureBar`. We don't draw a depth ladder we can't keep live;
 * one ratio from the last poll is honest.
 */
export function bookSums(
  depth: DepthDto,
  levels = PRESSURE_LEVELS,
): { bids: Decimal; asks: Decimal } {
  const sum = (side: DepthDto['bids']) =>
    side
      .slice(0, levels)
      .reduce((total, level) => total + (Number(level.size) || 0), 0)
      .toFixed(8);
  return { bids: sum(depth.bids), asks: sum(depth.asks) };
}

// ---------------------------------------------------------------------------
// Agents trading this market
// ---------------------------------------------------------------------------

/**
 * Whether an agent's mandate lets it trade `market`. A Kuru mandate names
 * OrderBook addresses (mapped back with `marketFor`); a Perpl mandate names
 * symbols, written either as `ETH-PERP` or as the bare base `ETH`.
 *
 * This is what keeps the section cheap: only these agents' portfolios are
 * fetched, not every agent's.
 */
export function mandateCovers(agent: Agent, market: MarketDto): boolean {
  if (market.venue === 'kuru') {
    return agent.mandate.kuru.markets.some(
      (address) => marketFor(address)?.symbol === market.symbol,
    );
  }
  const names = new Set([market.symbol, market.base].map((s) => s.toUpperCase()));
  return agent.mandate.perpl.markets.some((m) => names.has(m.trim().toUpperCase()));
}

/** Active agents whose mandate includes `market`, in the order the API listed them. */
export function agentsFor(agents: readonly Agent[], market: MarketDto): Agent[] {
  return agents.filter((agent) => agent.status === 'active' && mandateCovers(agent, market));
}

export type AgentStake = {
  /** `Long 0.25 ETH 3× from 2,498.00`, `Holds 180 MON at 0.9744`, `No position right now`. */
  line: string;
  /** Unrealised P&L in the market's quote, or `null` when there is none to mark. */
  pnl: Decimal | null;
};

/**
 * One agent's stake in `market`, read from its portfolio. `null` portfolio
 * (the route isn't deployed, or the read failed) says only that it may trade
 * here: the card still links to its cockpit, it just has no number to show.
 */
export function agentStake(portfolio: AgentPortfolioDto | null, market: MarketDto): AgentStake {
  const none = {
    line: portfolio === null ? 'Allowed to trade here' : 'No position right now',
    pnl: null,
  };
  if (portfolio === null) return none;
  const tick = market.tickSize;

  if (market.kind === 'perp') {
    const section = portfolio.perpl;
    if (!section.ok || section.status !== 'ok') return none;
    const position = section.positions.find((p) => p.symbol === market.symbol);
    if (position === undefined || Number(position.size) === 0) return none;
    const side = position.side === 'long' ? 'Long' : 'Short';
    const entry = formatPrice(position.entryPrice, tick) ?? position.entryPrice;
    return {
      line: `${side} ${trimZeros(position.size)} ${market.base} ${position.leverage}× from ${entry}`,
      pnl: position.unrealizedPnl,
    };
  }

  const holding = portfolio.holdings.find((h) => h.market === market.symbol);
  if (holding === undefined || !(Number(holding.amount) > 0)) return none;
  const avg = holding.costBasis.avgPrice;
  const at = avg === null ? '' : ` at ${formatPrice(avg, tick) ?? avg}`;
  return {
    line: `Holds ${trimZeros(holding.amount)} ${market.base}${at}`,
    pnl: holding.costBasis.unrealizedPnl,
  };
}

/** `+1.22`, `−0.40`: a P&L's sign spelled out, two places. */
export function signedAmount(value: Decimal): string | null {
  const formatted = formatPlaces(value.replace(/^[+-]/, ''), 2);
  if (formatted === null) return null;
  if (Number(formatted.replace(/,/g, '')) === 0) return formatted;
  return value.trim().startsWith('-') ? `${MINUS}${formatted}` : `+${formatted}`;
}

function trimZeros(value: Decimal): string {
  return value.includes('.') ? value.replace(/\.?0+$/, '') : value;
}
