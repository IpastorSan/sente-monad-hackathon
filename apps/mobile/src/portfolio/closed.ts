/**
 * Closed positions (SEN-154): the user's own fills, replayed into the round
 * trips they made, each with its realised P&L. Pure, like `view.ts`, so
 * `closed.test.ts` pins every rule under plain `node --test`.
 *
 * There is no closed-positions route: `/portfolio/fills` is the only record,
 * so the phone rebuilds them, per venue and market, oldest fill first:
 *
 * - A round trip opens when a fill moves a flat market off zero and closes
 *   when the size is back at zero. Anything still held is open, not closed,
 *   and is not listed here (it is on the Open list).
 * - Exits match entries FIFO, the same cost-basis rule the server's verdicts
 *   use (`services/api/src/agents/events/verdict.ts`), so a closed position
 *   here and a verdict there agree on the same fills. A partial close realises
 *   against the oldest lots first and splits a lot when it has to.
 * - Kuru is spot: there is no short. A sell with no buy of this history
 *   behind it is base that came from elsewhere (a deposit, a gift), whose cost
 *   these fills do not know; it is left out of the arithmetic, the trip ends
 *   at zero and a note says so — the verdict rule's "clamped at zero".
 * - Perpl can flip: a sell bigger than the long closes the long and opens a
 *   short with the rest, at the same price. Each side is its own trip.
 * - Fees follow the verdict file's fee rule (SEN-128): realised on the fill
 *   that paid them, the WHOLE fee, quote as it arrives, any other asset read
 *   as base at that fill's price. A fill that flips a perp pays one fee for
 *   two trips, so it is split between them by size. `/portfolio/fills`
 *   carries each fill's fee (SEN-162); a trip with any fill whose fee is
 *   unknown is "before fees" and says so (`feesIncluded`, `closedNotes`).
 * - Perpl funding is not in fills at all, so a perp's realised P&L here is
 *   price and fees only.
 *
 * The replay is only as right as the history it is given: a lot bought
 * before the oldest fill read would shift every FIFO match after it. So the
 * caller says which venues it has read to the end (`FillCoverage`), and a
 * venue that is not complete gets no rows and no total, only the reason.
 *
 * Money stays exact: every decimal is a bigint with its own scale, and only
 * the percent is a float.
 */
import type { PortfolioFill, PortfolioVenue } from '../trade/types.ts';
import { signedFigure } from '../ui/money.ts';
import { formatPct, formatPrice, type Direction } from '../ui/tradingFormat.ts';

import { amountText, baseOf, cents, shortDate, shown } from './view.ts';

// ---------------------------------------------------------------------------
// Exact decimals

type Dec = { atoms: bigint; scale: number };

const ZERO: Dec = { atoms: 0n, scale: 0 };
const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/u;

function dec(value: string): Dec | null {
  const match = DECIMAL.exec(value.trim());
  if (!match) return null;
  const [, sign, whole = '0', fraction = ''] = match;
  const atoms = BigInt(whole + fraction);
  return { atoms: sign === '-' ? -atoms : atoms, scale: fraction.length };
}

function align(a: Dec, b: Dec): [bigint, bigint, number] {
  const scale = Math.max(a.scale, b.scale);
  return [
    a.atoms * 10n ** BigInt(scale - a.scale),
    b.atoms * 10n ** BigInt(scale - b.scale),
    scale,
  ];
}

function add(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { atoms: x + y, scale };
}

function sub(a: Dec, b: Dec): Dec {
  const [x, y, scale] = align(a, b);
  return { atoms: x - y, scale };
}

function mul(a: Dec, b: Dec): Dec {
  return { atoms: a.atoms * b.atoms, scale: a.scale + b.scale };
}

function cmp(a: Dec, b: Dec): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

function min(a: Dec, b: Dec): Dec {
  return cmp(a, b) <= 0 ? a : b;
}

function isZero(a: Dec): boolean {
  return a.atoms === 0n;
}

/**
 * `a / b` to a fixed number of places, truncated. Only for the average entry
 * and exit prices a row prints, never for money that is added up.
 */
function div(a: Dec, b: Dec, places = 18): Dec {
  if (b.atoms === 0n) return ZERO;
  // a/b = (a.atoms / 10^a.scale) / (b.atoms / 10^b.scale)
  const shift = places + b.scale - a.scale;
  const num = shift >= 0 ? a.atoms * 10n ** BigInt(shift) : a.atoms / 10n ** BigInt(-shift);
  return { atoms: num / b.atoms, scale: places };
}

/** A plain decimal string without trailing zeros: `1.5`, `-0.25`, `3`. */
function text({ atoms, scale }: Dec): string {
  const negative = atoms < 0n;
  const digits = (negative ? -atoms : atoms).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale);
  const fraction = digits.slice(digits.length - scale).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

// ---------------------------------------------------------------------------
// The replay

/**
 * A fill as the replay reads it. A fill with no `fee` (`null`, or absent in
 * a hand-built one) marks its trip before fees rather than counting as
 * fee-free (SEN-162).
 */
export type ClosableFill = Pick<
  PortfolioFill,
  'venue' | 'tradeId' | 'venueTradeId' | 'symbol' | 'side' | 'price' | 'size' | 'timestamp'
> &
  Partial<Pick<PortfolioFill, 'fee' | 'feeAsset'>>;

export type ClosedPosition = {
  key: string;
  /** The fill that closed it, as `fillKey` names it, so History can show the P&L on it. */
  closedBy: string;
  venue: PortfolioVenue;
  symbol: string;
  direction: 'long' | 'short';
  /** The size opened, which is the size closed. */
  size: string;
  /** Size-weighted average entry and exit prices, fees excluded. */
  entry: string;
  exit: string;
  /** Entry notional of the matched size, in `pnlAsset`: what the percent is of. */
  costBasis: string;
  /** In `pnlAsset`, in the trip's own direction, net of every fee its fills carried. */
  realisedPnl: string;
  /** Kuru: the market's quote. Perpl: AUSD, what it settles in. */
  pnlAsset: string;
  /** `realisedPnl` over `costBasis`, in percent. */
  pct: number | null;
  openedAt: number;
  closedAt: number;
  /** Fills that took part, including one that flipped a perp. */
  fills: number;
  /** Every fill of the trip carried its fee, so `realisedPnl` is after fees. */
  feesIncluded: boolean;
  /** What the number leaves out, as whole sentences. */
  notes: string[];
};

export type ClosedReplay = {
  /** Newest close first. */
  positions: ClosedPosition[];
  /** Fills with no market or no side, which cannot be placed in any trip, per venue. */
  unplaced: Record<PortfolioVenue, number>;
};

/** Perpl settles in AUSD whatever the market (`verdict.ts` `PERPL_PNL_ASSET`). */
const PERPL_PNL_ASSET = 'AUSD';

type Lot = { size: Dec; price: Dec };

type Trip = {
  direction: 'long' | 'short';
  lots: Lot[];
  opened: Dec;
  openNotional: Dec;
  closed: Dec;
  closeNotional: Dec;
  costBasis: Dec;
  pnl: Dec;
  openedAt: number;
  fills: number;
  feesIncluded: boolean;
  unmatched: Dec;
};

function pnlAssetOf(venue: PortfolioVenue, symbol: string): string {
  if (venue === 'perpl') return PERPL_PNL_ASSET;
  return symbol.split(/[-/]/u)[1] ?? 'USDC';
}

/**
 * The fee a fill paid, in the P&L asset, per the verdict file's fee rule
 * (SEN-128). `null` when the fill does not say, which is not the same as zero.
 */
function feeOf(fill: ClosableFill, price: Dec, pnlAsset: string): Dec | null {
  if (fill.fee === undefined || fill.fee === null) return null;
  const fee = dec(fill.fee);
  if (fee === null) return null;
  const asset = fill.feeAsset ?? null;
  return asset !== null && asset !== pnlAsset ? mul(fee, price) : fee;
}

function fillKey(fill: ClosableFill): string {
  return `${fill.venue}:${fill.tradeId ?? ''}:${fill.venueTradeId}`;
}

/** Every closed round trip in `fills`, any order in, newest close first out. */
export function closedPositions(fills: readonly ClosableFill[]): ClosedReplay {
  const unplaced: Record<PortfolioVenue, number> = { kuru: 0, perpl: 0 };
  const markets = new Map<string, ClosableFill[]>();
  const seen = new Set<string>();
  for (const fill of fills) {
    // Pages can overlap when a new fill shifts them; a fill counts once.
    const key = fillKey(fill);
    if (seen.has(key)) continue;
    seen.add(key);
    if (fill.symbol === null || fill.side === null) {
      unplaced[fill.venue] += 1;
      continue;
    }
    const market = `${fill.venue}:${fill.symbol}`;
    const list = markets.get(market) ?? [];
    list.push(fill);
    markets.set(market, list);
  }

  const positions: ClosedPosition[] = [];
  for (const list of markets.values()) {
    // Oldest first. Fills arrive newest first, so a stable sort on time keeps
    // same-time fills in their venue order once reversed.
    const ordered = [...list].reverse().sort((a, b) => a.timestamp - b.timestamp);
    positions.push(...replayMarket(ordered));
  }
  positions.sort((a, b) => b.closedAt - a.closedAt || a.key.localeCompare(b.key));
  return { positions, unplaced };
}

function replayMarket(fills: readonly ClosableFill[]): ClosedPosition[] {
  const out: ClosedPosition[] = [];
  let trip: Trip | null = null;
  for (const fill of fills) {
    const venue = fill.venue;
    const symbol = fill.symbol!;
    const pnlAsset = pnlAssetOf(venue, symbol);
    const price = dec(fill.price);
    const size = dec(fill.size);
    if (price === null || size === null || size.atoms <= 0n) continue;
    const fee = feeOf(fill, price, pnlAsset);
    const buying = fill.side === 'buy';

    if (trip === null) {
      // Spot has no short: a sell from flat is base these fills never bought.
      if (venue === 'kuru' && !buying) continue;
      trip = openTrip(buying ? 'long' : 'short', fill.timestamp);
    }

    const opening = (trip.direction === 'long') === buying;
    trip.fills += 1;
    if (fee === null) trip.feesIncluded = false;
    if (opening) {
      trip.lots.push({ size, price });
      trip.opened = add(trip.opened, size);
      trip.openNotional = add(trip.openNotional, mul(size, price));
      if (fee !== null) trip.pnl = sub(trip.pnl, fee);
      continue;
    }

    let left = size;
    const sign = trip.direction === 'long' ? 1n : -1n;
    while (!isZero(left) && trip.lots.length > 0) {
      const lot = trip.lots[0]!;
      const take = min(left, lot.size);
      const move = mul(sub(price, lot.price), take);
      trip.pnl = add(trip.pnl, { atoms: move.atoms * sign, scale: move.scale });
      trip.costBasis = add(trip.costBasis, mul(lot.price, take));
      trip.closed = add(trip.closed, take);
      trip.closeNotional = add(trip.closeNotional, mul(price, take));
      lot.size = sub(lot.size, take);
      left = sub(left, take);
      if (isZero(lot.size)) trip.lots.shift();
    }
    // The part of this fill's fee that belongs to the trip it closed: all of
    // it, unless the rest of the fill goes on to open the other side.
    const flips = venue === 'perpl' && !isZero(left);
    if (fee !== null) {
      const share = flips ? div(mul(fee, sub(size, left)), size) : fee;
      trip.pnl = sub(trip.pnl, share);
    }
    if (!flips && !isZero(left)) trip.unmatched = add(trip.unmatched, left);
    if (trip.lots.length > 0) continue;

    out.push(finish(trip, venue, symbol, pnlAsset, fill));
    trip = null;
    if (flips) {
      trip = openTrip(buying ? 'long' : 'short', fill.timestamp);
      trip.fills = 1;
      trip.lots.push({ size: left, price });
      trip.opened = left;
      trip.openNotional = mul(left, price);
      if (fee === null) trip.feesIncluded = false;
      else trip.pnl = sub(trip.pnl, div(mul(fee, left), size));
    }
  }
  // A trip still holding lots is an open position, not a closed one.
  return out;
}

function openTrip(direction: 'long' | 'short', at: number): Trip {
  return {
    direction,
    lots: [],
    opened: ZERO,
    openNotional: ZERO,
    closed: ZERO,
    closeNotional: ZERO,
    costBasis: ZERO,
    pnl: ZERO,
    openedAt: at,
    fills: 0,
    feesIncluded: true,
    unmatched: ZERO,
  };
}

function finish(
  trip: Trip,
  venue: PortfolioVenue,
  symbol: string,
  pnlAsset: string,
  last: ClosableFill,
): ClosedPosition {
  const notes: string[] = [];
  if (!isZero(trip.unmatched)) {
    notes.push(
      `${text(trip.unmatched)} sold had no buy in your fills behind it, so it is left out.`,
    );
  }
  const basis = Number(text(trip.costBasis));
  const pnl = Number(text(trip.pnl));
  return {
    key: `${venue}:${symbol}:${trip.openedAt}:${fillKey(last)}`,
    closedBy: fillKey(last),
    venue,
    symbol,
    direction: trip.direction,
    size: text(trip.opened),
    entry: text(div(trip.openNotional, trip.opened)),
    exit: text(div(trip.closeNotional, trip.closed)),
    costBasis: text(trip.costBasis),
    realisedPnl: text(trip.pnl),
    pnlAsset,
    pct: basis > 0 && Number.isFinite(pnl) ? (pnl / basis) * 100 : null,
    openedAt: trip.openedAt,
    closedAt: last.timestamp,
    fills: trip.fills,
    feesIncluded: trip.feesIncluded,
    notes,
  };
}

// ---------------------------------------------------------------------------
// What the Closed list may show

/**
 * How much of a venue's fill history the phone holds. Only `complete` can be
 * replayed: `paging` has older pages unread, `unread` failed, and Perpl is
 * `unlinked` until the server holds its read key (SEN-151).
 */
export type VenueCoverage = 'loading' | 'complete' | 'paging' | 'unread' | 'unlinked';
export type FillCoverage = Record<PortfolioVenue, VenueCoverage>;

export type ClosedList = {
  positions: ClosedPosition[];
  /**
   * The realised total in ≈ $ (USDC and AUSD as $1, like the rest of the tab);
   * `null` whenever any venue is not complete, because a total over part of
   * the history is a wrong number, not a smaller one.
   */
  total: string | null;
  /** Every trip is after fees. */
  feesIncluded: boolean;
  /** Why rows or the total are missing, one sentence per reason. */
  gaps: string[];
  /** Still reading pages: say so rather than "no closed positions". */
  reading: boolean;
};

const VENUE_NAME: Record<PortfolioVenue, string> = { kuru: 'Kuru', perpl: 'Perpl' };

function gapLine(venue: PortfolioVenue, coverage: VenueCoverage): string | null {
  const name = VENUE_NAME[venue];
  switch (coverage) {
    case 'paging':
      return `Still reading your older ${name} fills; its closed positions show once they are all in.`;
    case 'unread':
      return `${name} didn’t answer, so its closed positions are left out for now.`;
    case 'unlinked':
      return `${name} closed positions show here once ${name} is linked.`;
    default:
      return null;
  }
}

/**
 * The Closed list: the trips of every venue whose history is complete, and a
 * line for each one that is not. A venue with fills that lost their market
 * or side is withheld too, since those fills could belong to any trip on it.
 */
export function closedList(fills: readonly ClosableFill[], coverage: FillCoverage): ClosedList {
  const replay = closedPositions(fills);
  const gaps: string[] = [];
  const shown = new Set<PortfolioVenue>();
  for (const venue of ['kuru', 'perpl'] as const) {
    const cover = coverage[venue];
    const line = gapLine(venue, cover);
    if (line !== null) gaps.push(line);
    if (cover !== 'complete') continue;
    const lost = replay.unplaced[venue];
    if (lost > 0) {
      gaps.push(
        `${lost} ${VENUE_NAME[venue]} fill${lost === 1 ? '' : 's'} lost ${
          lost === 1 ? 'its' : 'their'
        } market, so ${VENUE_NAME[venue]} closed positions are left out.`,
      );
      continue;
    }
    shown.add(venue);
  }
  const positions = replay.positions.filter((p) => shown.has(p.venue));
  const complete = gaps.length === 0 && shown.size === 2;
  let total: Dec = ZERO;
  for (const p of positions) total = add(total, dec(p.realisedPnl) ?? ZERO);
  return {
    positions,
    total: complete ? text(total) : null,
    feesIncluded: positions.every((p) => p.feesIncluded),
    gaps,
    reading: coverage.kuru === 'loading' || coverage.perpl === 'loading',
  };
}

/**
 * The sentences under the list. "Before fees" only when some trip shown has
 * a fill whose fee the venue did not report (SEN-162): once fills carry
 * fees, every other trip's P&L is already after them.
 */
export function closedNotes(list: Pick<ClosedList, 'positions' | 'feesIncluded'>): string[] {
  const notes: string[] = [];
  if (!list.feesIncluded) {
    notes.push('Some fills didn’t report their fee, so those positions are before fees.');
  }
  if (list.positions.some((p) => p.venue === 'perpl')) notes.push('Perp funding is not included.');
  return notes;
}

// ---------------------------------------------------------------------------
// A row

export type ClosedRow = {
  key: string;
  /** `MON` for spot, `ETH-PERP` for a perp: what the Open list calls it. */
  title: string;
  spot: boolean;
  direction: 'long' | 'short';
  /** `10.00 MON · 1.1000 → 1.3000 · Kuru`. */
  caption: string;
  /** `+2.00`, masked when balances are hidden. */
  pnl: string;
  pnlAsset: string;
  /** `+18.18% · Sep 20 – Sep 24`: the percent stays visible, like on the Open list. */
  under: string;
  tone: Direction;
};

/** What one closed position prints. Money through `ui/money.ts` (SEN-136). */
export function closedRow(p: ClosedPosition, hidden: boolean): ClosedRow {
  const spot = p.venue === 'kuru';
  const base = baseOf(p.symbol);
  const size = spot ? amountText(p.size, base) : p.size;
  // Floored to the cent like every Portfolio figure (SEN-179): a 0.004 loss is −0.01, not 0.00.
  const figure = signedFigure(cents(p.realisedPnl), 2);
  const opened = shortDate(p.openedAt);
  const closed = shortDate(p.closedAt);
  const dates = opened === closed ? closed : `${opened} – ${closed}`;
  return {
    key: p.key,
    title: spot ? base : p.symbol,
    spot,
    direction: p.direction,
    caption: `${shown(size, hidden)} ${base} · ${formatPrice(p.entry) ?? p.entry} → ${
      formatPrice(p.exit) ?? p.exit
    } · ${VENUE_NAME[p.venue]}`,
    pnl: shown(figure?.text ?? '—', hidden),
    pnlAsset: p.pnlAsset,
    under: p.pct !== null ? `${formatPct(p.pct)} · ${dates}` : dates,
    // The rounded money's sign, so a row that prints 0.00 is not tinted.
    tone: figure?.tone ?? 'flat',
  };
}

/** `+$1,204.50` for the list's total, masked when hidden; `null` stays `null`. */
export function closedTotal(total: string | null, hidden: boolean): string | null {
  if (total === null) return null;
  const figure = signedFigure(cents(total), 2);
  return figure === null ? null : `${figure.sign}$${shown(figure.magnitude, hidden)}`;
}
