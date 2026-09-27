/**
 * What the Portfolio tab and your own position SAY (SEN-118, plan U-12): the
 * ≈ $ total and its split, the cash card, your spot and perp rows, the "With
 * your agents" group, open orders with their distance to the market, the
 * fills history, and what hiding balances hides.
 *
 * Pure, like `agents/cockpit.ts`: no React, no React Native, so `view.test.ts`
 * pins every rule under plain `node --test` and the screens only lay out.
 *
 * Money stays a decimal string. Totals add USDC and AUSD as if both were
 * dollars and price every other asset at its Kuru last price, so every figure
 * that mixes them is "≈ $" and says so; an asset with no price is left out of
 * the total and named, never counted as zero.
 */
import type { Agent, AgentPortfolioDto, BalanceDto, OrderDto, PositionDto } from '../agents/api.ts';
import { sumDecimals } from '../agents/ledgerView.ts';
import type { TickerDto } from '../markets/api.ts';
import type { Portfolio, PortfolioFill } from '../trade/types.ts';
import { formatPrice as formatPlaces } from '../ui/chart/geometry.ts';
import { BALANCE_PLACES } from '../ui/format.ts';
import { signedFigure } from '../ui/money.ts';
import { formatPct, maskDigits, pctDirection, type Direction } from '../ui/tradingFormat.ts';

const MINUS = '−';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Kuru quotes in USDC, Perpl settles in AUSD: the two cash currencies, each counted as $1. */
export const STABLES: readonly string[] = ['USDC', 'AUSD'];

// ---------------------------------------------------------------------------
// Decimals

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/u;

type Parsed = { atoms: bigint; scale: number };

function parse(value: string): Parsed | null {
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  const atoms = BigInt(whole + fraction);
  return { atoms: sign === '-' ? -atoms : atoms, scale: fraction.length };
}

function render({ atoms, scale }: Parsed): string {
  const negative = atoms < 0n;
  const digits = (negative ? -atoms : atoms).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = scale > 0 ? `.${digits.slice(digits.length - scale)}` : '';
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** `a × b`, exactly. `null` when either is not a plain decimal. */
export function mulDecimal(a: string, b: string): string | null {
  const x = parse(a);
  const y = parse(b);
  if (x === null || y === null) return null;
  return render({ atoms: x.atoms * y.atoms, scale: x.scale + y.scale });
}

/** `a − b`, exactly. */
export function subDecimal(a: string, b: string): string | null {
  const negated = b.trim().startsWith('-') ? b.trim().slice(1) : `-${b.trim()}`;
  return sumDecimals([a, negated]);
}

function sum(values: readonly string[]): string {
  return sumDecimals(values) ?? '0';
}

function isPositive(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  const parsed = parse(value);
  return parsed !== null && parsed.atoms > 0n;
}

/** A display ratio: floats are fine for a percent, never for the money itself. */
function ratio(part: string, whole: string): number | null {
  const p = Number(part);
  const w = Number(whole);
  if (!Number.isFinite(p) || !Number.isFinite(w) || w === 0) return null;
  return (p / w) * 100;
}

/**
 * A money figure at 2 places, grouped: `3,918.40`. Rounded (it is a total, not
 * a spendable balance); a negative one takes a true minus.
 */
export function money(value: string | null, places = 2): string {
  if (value === null) return '—';
  return formatPlaces(value, places) ?? '—';
}

/** `≈ $3,918.40`: every figure that adds USDC and AUSD together. */
export function approxUsd(value: string | null): string {
  return value === null ? '—' : `≈ $${money(value)}`;
}

/**
 * A balance in its own token, TRUNCATED to the places `ui/format.ts` gives
 * that token (MON 4, stables 2, anything else 4): a balance is read when
 * deciding what it can cover, so it must never show a hundredth you don't
 * have. Mirrors `formatBalance`, which works on atoms.
 */
export function amountText(value: string, symbol: string): string {
  const places = BALANCE_PLACES[symbol] ?? 4;
  const parsed = parse(value);
  if (parsed === null) return value;
  const drop = Math.max(0, parsed.scale - places);
  const truncated = { atoms: parsed.atoms / 10n ** BigInt(drop), scale: parsed.scale - drop };
  return formatPlaces(render(truncated), places) ?? value;
}

/** `+11.53` / `−4.10` / `0.00`, at 2 places. */
export function signedMoney(value: string | null): string {
  // The app's one signed formatter (SEN-136), so this agrees with the agent screens.
  return signedFigure(value, 2)?.text ?? '—';
}

export function toneOf(value: string | null): Direction {
  return signedFigure(value, 2)?.tone ?? 'flat';
}

// ---------------------------------------------------------------------------
// Hiding balances

/**
 * The eye hides amounts, sizes and values and keeps percentages, sides and
 * markets (study: "direction, not wealth"). A hidden figure keeps its shape.
 */
export function shown(value: string, hidden: boolean): string {
  return hidden ? maskDigits(value) : value;
}

// ---------------------------------------------------------------------------
// Prices

/**
 * What one unit of `asset` is worth in dollars: 1 for USDC and AUSD, else the
 * Kuru `<asset>-USDC` last price (then mid). `null` when nothing quotes it.
 */
export function usdPrice(asset: string, tickers: readonly TickerDto[]): string | null {
  if (STABLES.includes(asset)) return '1';
  const ticker = tickers.find((t) => t.venue === 'kuru' && t.symbol === `${asset}-USDC`);
  return ticker?.last ?? ticker?.mid ?? null;
}

// ---------------------------------------------------------------------------
// Your holdings

/** A wallet balance, from `/portfolio` or, with trading off, from `/wallet`. */
export type WalletAmount = { readonly symbol: string; readonly amount: string };

export type CashLine = {
  symbol: string;
  amount: string;
  /** `for perps` / `for spot`: each currency sits next to what it's for. */
  purpose: string;
};

/** Stablecoins parked inside a venue account: still yours, still cash. */
export type VenueCash = { venue: 'kuru' | 'perpl'; asset: string; amount: string };

export type SpotRow = {
  asset: string;
  /** Wallet plus Kuru account, in the asset. */
  amount: string;
  /** In USDC at the Kuru last price; `null` when unpriced. */
  value: string | null;
  price: string | null;
};

export type PerpRow = {
  position: PositionDto;
  /** Margin plus unrealised P&L, in AUSD: what closing it would hand back. */
  value: string;
  /** Unrealised P&L as a percent of margin, so it matches what you put in. */
  pctOnMargin: number | null;
};

export type Holdings = {
  cash: CashLine[];
  venueCash: VenueCash[];
  spot: SpotRow[];
  perps: PerpRow[];
  /** Assets held but left out of the ≈ $ total because nothing prices them. */
  unpriced: string[];
  /** `unlinked`: Perpl positions can't be read, so perps are unknown, not zero. */
  perpsUnknown: boolean;
  /** `/portfolio` sections that failed: left out of every figure, and said so. */
  unread: PortfolioSection[];
};

export type PortfolioSection = 'wallet' | 'kuru' | 'perpl';

/**
 * The sections of `/portfolio` that did not answer, in display order. Each
 * failed on its own (SEN-123), so the rest of the response is still real.
 */
export function unreadSections(portfolio: Portfolio | null): PortfolioSection[] {
  if (portfolio === null) return [];
  return (['wallet', 'kuru', 'perpl'] as const).filter((section) => !portfolio[section].ok);
}

/**
 * What a failed section says (SEN-123). The point is that its money is
 * unknown, not gone: a Kuru outage must never read as an empty Kuru account.
 */
export function sectionFailure(section: PortfolioSection): { title: string; detail: string } {
  switch (section) {
    case 'wallet':
      return {
        title: 'Your wallet didn’t answer — pull to retry',
        detail:
          'Cash comes from a separate balance read; other tokens in your wallet are left out until it answers.',
      };
    case 'kuru':
      return {
        title: 'Kuru didn’t answer — pull to retry',
        detail: 'Your Kuru balances and orders are left out until it does, not counted as zero.',
      };
    case 'perpl':
      return {
        title: 'Perpl didn’t answer — pull to retry',
        detail:
          'Your perps, Perpl cash and orders are left out until it does, not counted as zero.',
      };
  }
}

const CASH_PURPOSE: Record<string, string> = { AUSD: 'for perps', USDC: 'for spot' };

export function holdings(
  wallet: readonly WalletAmount[],
  portfolio: Portfolio | null,
  tickers: readonly TickerDto[],
): Holdings {
  // A failed section contributes nothing here and is named in `unread`, so
  // the screen can say it is missing rather than sum it as zero (SEN-123).
  const kuru = portfolio?.kuru.ok ? portfolio.kuru : null;
  const perpl = portfolio?.perpl.ok ? portfolio.perpl : null;
  const cash = ['AUSD', 'USDC'].map((symbol) => ({
    symbol,
    amount: wallet.find((b) => b.symbol === symbol)?.amount ?? '0',
    purpose: CASH_PURPOSE[symbol] ?? '',
  }));

  const venueCash: VenueCash[] = [];
  const spotAmounts = new Map<string, string[]>();
  const addSpot = (asset: string, amount: string) =>
    spotAmounts.set(asset, [...(spotAmounts.get(asset) ?? []), amount]);

  for (const b of wallet) if (!STABLES.includes(b.symbol)) addSpot(b.symbol, b.amount);
  for (const b of kuru?.balances ?? []) {
    if (STABLES.includes(b.asset)) {
      if (isPositive(b.total)) venueCash.push({ venue: 'kuru', asset: b.asset, amount: b.total });
    } else addSpot(b.asset, b.total);
  }

  const positions = perpl?.status === 'ok' ? (perpl.positions ?? []) : [];
  const perps = positions.map((position) => ({
    position,
    value: sum([position.margin, position.unrealizedPnl]),
    pctOnMargin: ratio(position.unrealizedPnl, position.margin),
  }));
  const perplFree = perplCash(perpl?.balances ?? [], perpl?.status === 'ok' ? positions : []);
  if (isPositive(perplFree)) venueCash.push({ venue: 'perpl', asset: 'AUSD', amount: perplFree });

  const spot: SpotRow[] = [];
  const unpriced: string[] = [];
  for (const [asset, amounts] of spotAmounts) {
    const amount = sum(amounts);
    if (!isPositive(amount)) continue;
    const price = usdPrice(asset, tickers);
    if (price === null) unpriced.push(asset);
    spot.push({ asset, amount, price, value: price === null ? null : mulDecimal(amount, price) });
  }
  spot.sort((a, b) => Number(b.value ?? 0) - Number(a.value ?? 0));

  return {
    cash,
    venueCash,
    spot,
    perps,
    unpriced,
    perpsUnknown: perpl?.status === 'unlinked',
    unread: unreadSections(portfolio),
  };
}

/**
 * Free AUSD in the Perpl account. With `ok` the venue's balance includes the
 * margin sitting in open positions, which the perp rows already count, so it
 * comes off here; with `unlinked` the chain's balance already excludes it.
 */
function perplCash(balances: readonly BalanceDto[], positions: readonly PositionDto[]): string {
  const total = sum(balances.filter((b) => b.asset === 'AUSD').map((b) => b.total));
  const free = subDecimal(total, sum(positions.map((p) => p.margin))) ?? '0';
  return free.startsWith('-') ? '0' : free;
}

// ---------------------------------------------------------------------------
// The total and its split

export type AllocationKey = 'cash' | 'agents' | 'spot' | 'perps';

export type AllocationSegment = {
  key: AllocationKey;
  label: string;
  usd: string;
  /** Whole percent of the total; the shown segments add up to 100. */
  share: number;
};

export type Allocation = { total: string; segments: AllocationSegment[] };

const ALLOCATION_LABEL: Record<AllocationKey, string> = {
  cash: 'Cash',
  agents: 'With agents',
  spot: 'Spot',
  perps: 'Perps',
};

/** Each part of the total in dollars, from your holdings and the agents group. */
export function allocationParts(
  held: Holdings,
  agentsUsd: string | null,
): Record<AllocationKey, string> {
  return {
    cash: sum([...held.cash.map((c) => c.amount), ...held.venueCash.map((c) => c.amount)]),
    agents: agentsUsd ?? '0',
    spot: sum(held.spot.flatMap((s) => (s.value === null ? [] : [s.value]))),
    perps: sum(held.perps.map((p) => p.value)),
  };
}

/**
 * The bar under the total: the non-empty parts in a fixed order (cash, agents,
 * spot, perps), with whole-percent shares by largest remainder so the legend
 * in hidden mode always adds up to 100. A negative part (a perp under water
 * past its margin cannot be, but a bad read could) is drawn as nothing.
 */
export function allocation(parts: Record<AllocationKey, string>): Allocation {
  const total = sum(Object.values(parts));
  const keys = (['cash', 'agents', 'spot', 'perps'] as const).filter((k) => isPositive(parts[k]));
  const whole = Number(sum(keys.map((k) => parts[k])));
  if (!(whole > 0)) return { total, segments: [] };
  const raw = keys.map((key) => ({ key, exact: (Number(parts[key]) / whole) * 100 }));
  const floors = raw.map((r) => Math.floor(r.exact));
  let left = 100 - floors.reduce((a, b) => a + b, 0);
  const order = raw
    .map((r, i) => ({ i, rest: r.exact - Math.floor(r.exact) }))
    .sort((a, b) => b.rest - a.rest);
  for (const { i } of order) {
    if (left <= 0) break;
    floors[i] = (floors[i] ?? 0) + 1;
    left -= 1;
  }
  return {
    total,
    segments: keys.map((key, i) => ({
      key,
      label: ALLOCATION_LABEL[key],
      usd: parts[key],
      share: floors[i] ?? 0,
    })),
  };
}

/** The legend's figure: dollars, or the share once balances are hidden. */
export function legendValue(segment: AllocationSegment, hidden: boolean): string {
  return hidden ? `${segment.share}%` : `$${money(segment.usd)}`;
}

// ---------------------------------------------------------------------------
// The hero's line: the total as this phone saw it

export type ValueSample = { at: number; usd: string };

/**
 * There is no value history on the server, so the hero draws what the phone
 * itself observed since the app opened, one sample per read. A sample is
 * dropped when it is within `minGapMs` of the last one, and the series keeps
 * the newest `max`.
 */
export function appendSample(
  series: readonly ValueSample[],
  sample: ValueSample,
  { max = 240, minGapMs = 5_000 }: { max?: number; minGapMs?: number } = {},
): ValueSample[] {
  const last = series[series.length - 1];
  if (last !== undefined && sample.at - last.at < minGapMs) {
    return [...series.slice(0, -1), sample];
  }
  return [...series, sample].slice(-max);
}

/** First to last sample, as `+$0.12` and a percent. `null` under two samples. */
export function seriesChange(
  series: readonly ValueSample[],
): { delta: string; pct: number | null; tone: Direction } | null {
  const first = series[0];
  const last = series[series.length - 1];
  if (first === undefined || last === undefined || series.length < 2) return null;
  const delta = subDecimal(last.usd, first.usd);
  if (delta === null) return null;
  const pct = ratio(delta, first.usd);
  return { delta, pct, tone: toneOf(delta) };
}

/** `+$0.12`, `−$4.10`: the change line's amount. */
export function signedUsd(delta: string): string {
  const signed = signedMoney(delta);
  if (signed.startsWith('+')) return `+$${signed.slice(1)}`;
  if (signed.startsWith(MINUS)) return `${MINUS}$${signed.slice(1)}`;
  return `$${signed}`;
}

// ---------------------------------------------------------------------------
// With your agents

export type AgentInput = {
  agent: Pick<Agent, 'id' | 'name' | 'status' | 'revokedAt'>;
  /** `null` when the route is missing or the read failed. */
  portfolio: AgentPortfolioDto | null;
};

export type AgentGroupRow =
  | {
      kind: 'position';
      key: string;
      agentId: string;
      symbol: string;
      base: string;
      side: 'long' | 'short';
      /** Perps only. */
      leverage: number | null;
      /** `Range Hunter · from 0.9744`. */
      caption: string;
      value: string | null;
      unit: 'USDC' | 'AUSD';
      pnl: string | null;
      pct: number | null;
    }
  | {
      kind: 'agent';
      key: string;
      agentId: string;
      name: string;
      revoked: boolean;
      /** `Revoked Sep 23`, `No open position`, `Holdings unavailable`. */
      caption: string;
      /** ≈ $, or `null` when unread. */
      value: string | null;
      /** `ready to return` for a revoked agent still holding funds. */
      aside: string | null;
    };

/**
 * The read-only group: every open position an agent holds (tap → its cockpit),
 * an agent with nothing open as one line with its ≈ $, and a revoked agent
 * only while it still holds funds, so money never drops out of the total
 * without a row saying where it went.
 */
export function agentGroup(inputs: readonly AgentInput[]): {
  rows: AgentGroupRow[];
  total: string | null;
} {
  const rows: AgentGroupRow[] = [];
  const totals: string[] = [];
  for (const { agent, portfolio } of inputs) {
    const revoked = agent.status === 'revoked';
    const value = portfolio?.totals.approxUsd ?? null;
    if (value !== null) totals.push(value);
    if (portfolio === null) {
      if (!revoked) {
        rows.push(agentRow(agent, 'Holdings unavailable', null, null));
      }
      continue;
    }
    const positions = agentPositions(agent, portfolio);
    if (revoked) {
      if (isPositive(value))
        rows.push(agentRow(agent, revokedCaption(agent), value, 'ready to return'));
      continue;
    }
    if (positions.length === 0) rows.push(agentRow(agent, 'No open position', value, null));
    rows.push(...positions);
  }
  return { rows, total: totals.length > 0 ? sum(totals) : null };
}

function agentRow(
  agent: AgentInput['agent'],
  caption: string,
  value: string | null,
  aside: string | null,
): AgentGroupRow {
  return {
    kind: 'agent',
    key: `agent:${agent.id}`,
    agentId: agent.id,
    name: agent.name,
    revoked: agent.status === 'revoked',
    caption,
    value,
    aside,
  };
}

function revokedCaption(agent: AgentInput['agent']): string {
  const at = agent.revokedAt ? Date.parse(agent.revokedAt) : NaN;
  return Number.isFinite(at) ? `Revoked ${shortDate(at)}` : 'Revoked';
}

/**
 * Its Perpl positions (value = margin + unrealised P&L, in AUSD) and every Kuru
 * holding its event log explains (value at the mark, in USDC) — the same
 * "explained holdings only" rule the cockpit's `positionRows` follows, so the
 * wallet's gas MON is not an agent "position".
 */
function agentPositions(agent: AgentInput['agent'], portfolio: AgentPortfolioDto): AgentGroupRow[] {
  const rows: AgentGroupRow[] = [];
  const perpl = portfolio.perpl;
  if (perpl.ok && perpl.status === 'ok') {
    for (const p of perpl.positions) {
      rows.push({
        kind: 'position',
        key: `${agent.id}:perpl:${p.symbol}:${p.side}`,
        agentId: agent.id,
        symbol: p.symbol,
        base: baseOf(p.symbol),
        side: p.side,
        leverage: p.leverage,
        caption: `${agent.name} · from ${p.entryPrice}`,
        value: sum([p.margin, p.unrealizedPnl]),
        unit: 'AUSD',
        pnl: p.unrealizedPnl,
        pct: ratio(p.unrealizedPnl, p.margin),
      });
    }
  }
  for (const h of portfolio.holdings) {
    if (!isPositive(h.costBasis.coveredSize)) continue;
    const { avgPrice, unrealizedPnl } = h.costBasis;
    const cost = avgPrice !== null ? mulDecimal(h.costBasis.coveredSize, avgPrice) : null;
    rows.push({
      kind: 'position',
      key: `${agent.id}:kuru:${h.market}`,
      agentId: agent.id,
      symbol: h.asset,
      base: h.asset,
      side: 'long',
      leverage: null,
      caption: avgPrice !== null ? `${agent.name} · from ${avgPrice}` : agent.name,
      value: h.value,
      unit: 'USDC',
      pnl: unrealizedPnl,
      pct: unrealizedPnl !== null && cost !== null ? ratio(unrealizedPnl, cost) : null,
    });
  }
  return rows;
}

export function baseOf(symbol: string): string {
  return symbol.split(/[-/]/u)[0] || symbol;
}

// ---------------------------------------------------------------------------
// Orders

export type OrderRow = {
  key: string;
  order: OrderDto;
  base: string;
  /** `Limit · MON-USDC · Kuru spot`. */
  kind: string;
  /** Size still resting, in the base asset. */
  remaining: string;
  /** `0 of 150.00 filled so far`. */
  filledLine: string;
  /** The market price the distance was measured from; `null` when unquoted. */
  market: string | null;
  /** `Fills if MON drops 3.18%.`; `null` without a limit price or a market price. */
  distance: string | null;
  /** 0..1 along the track for the limit and the market dots; `null` with no distance. */
  track: { limit: number; market: number } | null;
  /** What cancelling hands back, e.g. `142.50 USDC`; `null` when it can't be said. */
  backToCash: string | null;
  /** `Today 09:14 · good till cancelled`. */
  placed: string;
};

export function orderRows(
  portfolio: Portfolio | null,
  tickers: readonly TickerDto[],
  now: number,
): OrderRow[] {
  if (portfolio === null) return [];
  // A failed venue lists no orders; the screen names it from `unreadSections`.
  const orders = [
    ...(portfolio.kuru.ok ? portfolio.kuru.openOrders : []),
    ...(portfolio.perpl.ok ? (portfolio.perpl.openOrders ?? []) : []),
  ];
  return orders
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((order) => orderRow(order, tickers, now));
}

function orderRow(order: OrderDto, tickers: readonly TickerDto[], now: number): OrderRow {
  const base = baseOf(order.symbol);
  const spot = order.venue === 'kuru';
  const ticker = tickers.find((t) => t.venue === order.venue && t.symbol === order.symbol);
  const market = (spot ? ticker?.last : ticker?.mark) ?? ticker?.last ?? ticker?.mid ?? null;
  const remaining = subDecimal(order.size, order.filledSize) ?? order.size;
  const places = BALANCE_PLACES[base] ?? 2;
  const kind = `${order.type === 'limit' ? 'Limit' : 'Market'} · ${order.symbol} · ${
    spot ? 'Kuru spot' : 'Perpl'
  }`;
  const filledLine = `${formatPlaces(order.filledSize, places) ?? order.filledSize} of ${
    formatPlaces(order.size, places) ?? order.size
  } filled so far`;

  let distance: string | null = null;
  let track: OrderRow['track'] = null;
  if (order.price !== null && market !== null) {
    const pct = ratio(subDecimal(order.price, market) ?? '0', market);
    if (pct !== null) {
      const buying = order.side === 'buy';
      const away = buying ? -pct : pct;
      distance =
        away <= 0
          ? 'At or through the market: it should fill on the next match.'
          : `Fills if ${base} ${buying ? 'drops' : 'rises'} ${formatPct(away).replace(/^\+/u, '')}.`;
      track = trackFor(Number(order.price), Number(market));
    }
  }

  let backToCash: string | null = null;
  if (spot && order.side === 'buy' && order.price !== null) {
    const quote = mulDecimal(remaining, order.price);
    if (quote !== null) backToCash = `${amountText(quote, 'USDC')} USDC`;
  } else if (spot && order.side === 'sell') {
    backToCash = `${amountText(remaining, base)} ${base}`;
  }

  return {
    key: `${order.venue}:${order.id}`,
    order,
    base,
    kind,
    remaining,
    filledLine,
    market,
    distance,
    track,
    backToCash,
    placed: `${dayWord(order.createdAt, now)} ${clock(order.createdAt)} · good till cancelled`,
  };
}

/** Both points on a track that spans them with a margin, so neither sits on an edge. */
function trackFor(limit: number, market: number): { limit: number; market: number } | null {
  if (!Number.isFinite(limit) || !Number.isFinite(market)) return null;
  const lo = Math.min(limit, market);
  const hi = Math.max(limit, market);
  const pad = (hi - lo) * 0.25 || Math.abs(market) * 0.01 || 1;
  const at = (v: number) => Math.round(((v - (lo - pad)) / (hi - lo + 2 * pad)) * 1000) / 1000;
  return { limit: at(limit), market: at(market) };
}

// ---------------------------------------------------------------------------
// History

export type FillRow = {
  key: string;
  /** `Buy` / `Sell`, or `null` when the trade's summary was lost. */
  side: 'Buy' | 'Sell' | null;
  /** `412.00 MON`, `0.25 ETH-PERP`, or the size alone. */
  title: string;
  /** `at 0.9420 · Kuru spot`. */
  detail: string;
  time: string;
  /** `0x5d02…e7f9`; the full hash is `hash`. */
  tx: string | null;
  hash: string | null;
};

export type FillDay = { key: string; label: string; fills: FillRow[] };

/** Grouped by UTC day, newest first, like every other dated list in the app. */
export function fillDays(fills: readonly PortfolioFill[], now: number): FillDay[] {
  const days: FillDay[] = [];
  for (const fill of [...fills].sort((a, b) => b.timestamp - a.timestamp)) {
    const key = dayKey(fill.timestamp);
    let day = days[days.length - 1];
    if (day?.key !== key) {
      day = { key, label: dayLabel(fill.timestamp, now), fills: [] };
      days.push(day);
    }
    day.fills.push(fillRow(fill));
  }
  return days;
}

function fillRow(fill: PortfolioFill): FillRow {
  const spot = fill.venue === 'kuru';
  const base = fill.symbol !== null ? baseOf(fill.symbol) : null;
  const unit = fill.symbol === null ? '' : spot ? ` ${base}` : ` ${fill.symbol}`;
  const size = spot && base !== null ? amountText(fill.size, base) : fill.size;
  return {
    key: `${fill.venue}:${fill.tradeId}:${fill.venueTradeId}`,
    side: fill.side === 'buy' ? 'Buy' : fill.side === 'sell' ? 'Sell' : null,
    title: `${size}${unit}`,
    detail: `at ${fill.price} · ${spot ? 'Kuru spot' : 'Perpl'}`,
    time: clock(fill.timestamp),
    tx: fill.transactionHash !== null ? shortHash(fill.transactionHash) : null,
    hash: fill.transactionHash,
  };
}

function shortHash(hash: string): string {
  return hash.length > 12 ? `${hash.slice(0, 6)}…${hash.slice(-4)}` : hash;
}

// ---------------------------------------------------------------------------
// Your position

export type PerpDetail = {
  pnl: { sign: '+' | '−' | ''; magnitude: string; tone: Direction };
  /** `+5.54%` on margin. */
  pct: string;
  pctTone: Direction;
  /** `0.25 ETH · 636.03 AUSD` at the mark. */
  size: string;
  /** `208.17 AUSD · 3×`. */
  margin: string;
  /** `−0.38 AUSD`, or `null` when Perpl did not say. */
  funding: string | null;
  /** `LIQ est. 1,690.00 · 33.6% below`, or `null` without an estimate. */
  liq: string | null;
};

/**
 * The perp detail's words. The headline is unrealised P&L, not price, and its
 * percent is on margin; liquidation is always "est." (our formula, which
 * leaves out accrued funding) and sits under the chart with its distance.
 */
export function perpDetail(position: PositionDto, hidden = false): PerpDetail {
  const figure = signedFigure(position.unrealizedPnl, 2);
  const tone = figure?.tone ?? 'flat';
  const magnitude = figure?.magnitude ?? '—';
  const pct = ratio(position.unrealizedPnl, position.margin);
  const base = baseOf(position.symbol);
  const notional = mulDecimal(position.size, position.markPrice);
  let liq: string | null = null;
  if (position.liquidationPriceEst !== null) {
    const gap = ratio(
      subDecimal(position.markPrice, position.liquidationPriceEst) ?? '0',
      position.markPrice,
    );
    const where =
      gap === null ? '' : ` · ${Math.abs(gap).toFixed(1)}% ${gap >= 0 ? 'below' : 'above'}`;
    liq = `LIQ est. ${money(position.liquidationPriceEst, priceDecimals(position.liquidationPriceEst))}${where}`;
  }
  return {
    pnl: { sign: tone === 'up' ? '+' : tone === 'down' ? MINUS : '', magnitude, tone },
    pct: formatPct(pct),
    pctTone: pctDirection(pct),
    size: `${shown(position.size, hidden)} ${base} · ${shown(money(notional), hidden)} AUSD`,
    margin: `${shown(money(position.margin), hidden)} AUSD · ${position.leverage}×`,
    funding:
      position.fundingPaid !== null
        ? `${shown(signedMoney(negate(position.fundingPaid)), hidden)} AUSD`
        : null,
    liq,
  };
}

/** Funding PAID reads as money out: a positive payment is shown as a minus. */
function negate(value: string): string {
  const v = value.trim();
  return v.startsWith('-') ? v.slice(1) : `-${v}`;
}

function priceDecimals(value: string): number {
  return Math.abs(Number(value)) < 10 ? 4 : 2;
}

/** Your perp on `symbol`, or your spot holding of `symbol` (a base asset or its market). */
export function findPosition(
  held: Holdings,
  venue: string,
  symbol: string,
): { kind: 'perp'; row: PerpRow } | { kind: 'spot'; row: SpotRow } | null {
  if (venue === 'perpl') {
    const row = held.perps.find((p) => p.position.symbol === symbol);
    return row ? { kind: 'perp', row } : null;
  }
  if (venue === 'kuru') {
    const asset = baseOf(symbol);
    const row = held.spot.find((s) => s.asset === asset);
    return row ? { kind: 'spot', row } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Dates, in UTC like the rest of the app, so they read the same everywhere

function dayKey(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** `Sep 23`. */
export function shortDate(at: number): string {
  const iso = new Date(at).toISOString();
  return `${MONTHS[Number(iso.slice(5, 7)) - 1] ?? iso.slice(5, 7)} ${Number(iso.slice(8, 10))}`;
}

/** `Today`, `Yesterday`, or `Fri, Sep 25`. */
export function dayLabel(at: number, now: number): string {
  const day = dayKey(at);
  if (day === dayKey(now)) return 'Today';
  if (day === dayKey(now - 86_400_000)) return 'Yesterday';
  return `${WEEKDAYS[new Date(at).getUTCDay()]}, ${shortDate(at)}`;
}

function dayWord(at: number, now: number): string {
  return dayKey(at) === dayKey(now) ? 'Today' : shortDate(at);
}

/** `09:14`. */
export function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}
