/**
 * What the Home tab shows about the user's agents (SEN-57): which ones make
 * the short list, each one's card, and the newest event as one sentence.
 *
 * Plain node, no React Native, so `home.test.ts` pins every choice without a
 * device. The screen only lays these out.
 *
 * The latest move is built from the Ledger's own mapping (`toLedgerEntries`),
 * not from `detail` again: an event the Ledger does not show must not show up
 * on Home either, and a second parser is a second place for the two to drift.
 *
 * SEN-113 (plan U-7) made Home trading-first: the total, the markets strip,
 * the watchlist, the movers and the idle-cash nudge are chosen here too.
 */
import type { Decimal, MarketDto, TickerDto } from '../markets/api.ts';
import { asPercent, priceOf } from '../markets/marketsView.ts';
import {
  changeOf,
  marketKey,
  sortMarkets,
  type MarketKey,
  type TickerIndex,
} from '../markets/select.ts';
import {
  allocation,
  allocationParts,
  holdings,
  type Holdings,
  type WalletAmount,
} from '../portfolio/view.ts';
import type { Portfolio } from '../trade/types.ts';

import { formatFixedAtoms } from './amounts.ts';
import type { ActivityEvent, Agent, AgentSummary } from './api.ts';
import {
  depositAmount,
  directionLabel,
  heldLabel,
  signedPnl,
  toLedgerEntries,
  venueLabel,
  type EventConsensus,
  type LedgerEntry,
} from './ledger.ts';
import { stoneFor, sumDecimals, type LedgerStone } from './ledgerView.ts';
import { marketFor } from './mandate.ts';
import { describeMove, pnlTone, relativeAge, type Move } from './usage.ts';

/**
 * Home shows at most this many agents; "All" has the rest. Four since SEN-113:
 * the agents sit in a two-column grid, and three leaves a hole.
 */
export const HOME_AGENT_LIMIT = 4;

/**
 * The short list: active agents before revoked ones, and the most recently
 * busy first within each, so the agent doing something right now is the one
 * on screen. `Array.prototype.sort` is stable, so ties keep the API's order.
 */
export function homeAgents(
  agents: readonly Agent[],
  summaries: ReadonlyMap<string, AgentSummary>,
  limit: number = HOME_AGENT_LIMIT,
): Agent[] {
  const lastAt = (agent: Agent) => summaries.get(agent.id)?.lastEvent?.at ?? 0;
  return [...agents]
    .sort((a, b) => {
      if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
      return lastAt(b) - lastAt(a);
    })
    .slice(0, limit);
}

/** Which stone a move gets: the Ledger's own (`ledgerView.stoneFor`). */
export type MoveStone = LedgerStone;

export type LatestMove = {
  agentId: string;
  at: number;
  stone: MoveStone;
  /** One line, the agent as its subject: `Range Hunter bought 180 MON-USDC`. */
  title: string;
  /** The line under it, or `null` when there is nothing worth a second line. */
  detail: string | null;
  /** Set when the event names a block, so the screen can draw the ramp. */
  block: { number: number; consensus: EventConsensus | null } | null;
};

/**
 * The newest event as a Home row, or `null` when the Ledger would not show it
 * (a run summary, a filled `order` whose `fill` says it better) — the section
 * is then left out rather than showing something half-read.
 */
export function latestMove(event: ActivityEvent): LatestMove | null {
  const [entry] = toLedgerEntries([event]);
  if (!entry) return null;
  return {
    agentId: event.agentId,
    at: entry.at,
    ...describe(entry, event.agentName),
    block: blockOf(entry),
  };
}

function describe(
  entry: LedgerEntry,
  name: string,
): { stone: MoveStone; title: string; detail: string | null } {
  switch (entry.kind) {
    case 'trade': {
      if (!entry.filled) {
        return {
          stone: 'trade',
          title: `${name}’s ${entry.market} order did not fill`,
          detail: entry.status,
        };
      }
      const verb =
        entry.direction === 'long' ? 'bought' : entry.direction === 'short' ? 'sold' : 'traded';
      const where = [
        entry.price !== null ? `at ${entry.price}` : null,
        entry.leverage !== null ? `${entry.leverage}×` : null,
        entry.venue !== null ? `on ${venueLabel(entry.venue)}` : null,
      ].filter((part): part is string => part !== null);
      return {
        stone: 'trade',
        title: `${name} ${verb} ${entry.size} ${entry.market}`,
        detail: where.length > 0 ? where.join(' ') : null,
      };
    }
    case 'thesis':
      return {
        stone: 'thesis',
        title: `${name} wrote a thesis`,
        detail:
          entry.direction !== null
            ? `${directionLabel(entry.direction)} · ${entry.market}`
            : entry.market,
      };
    case 'refusal':
      return {
        stone: 'refusal',
        title:
          entry.layer === 'enclave'
            ? `The enclave held ${name} to its mandate`
            : `Sente stopped an order from ${name}`,
        detail: entry.message || entry.code,
      };
    case 'verdict': {
      return {
        stone: stoneFor(entry),
        title:
          entry.market !== null ? `${name} closed ${entry.market}` : `${name} closed a position`,
        detail: `${signedPnl(entry.pnl)} · ${heldLabel(entry.held)}`,
      };
    }
    case 'deposit':
      return {
        stone: 'deposit',
        title: `${name} received ${depositAmount(entry)}${entry.asset !== null ? ` ${entry.asset}` : ''}`,
        detail: null,
      };
  }
}

function blockOf(entry: LedgerEntry): LatestMove['block'] {
  if (entry.kind === 'thesis' || entry.kind === 'refusal') return null;
  if (entry.blockNumber === null) return null;
  return { number: entry.blockNumber, consensus: entry.consensus };
}

/** `now`, `4m ago`, `3h ago`, `2d ago`. Coarse on purpose: it is a glance, not a record. */
export function sinceLabel(at: number, now: number): string {
  const age = relativeAge(at, now);
  return age === 'now' ? age : `${age} ago`;
}

// ---------------------------------------------------------------------------
// Trading-first Home (SEN-113, plan U-7)

const DAY_MS = 24 * 60 * 60_000;

/** The stablecoins the total counts. MON is gas (sponsored), not capital. */
const CASH_SYMBOLS: readonly string[] = ['AUSD', 'USDC'];

/** Where one agent's figure in the total came from. */
export type AgentCapital =
  /** `GET /agents/:id/portfolio` answered: wallet, venue accounts and positions. */
  | { source: 'portfolio'; value: Decimal }
  /** That route is not deployed (it answers `null`): the agent wallet's stables only. */
  | { source: 'wallet'; value: Decimal }
  /** Neither answered: left out of the sum, and the sentence says so. */
  | { source: 'unread' };

export type TotalValue = {
  /** ≈ $: USDC and AUSD added as dollars. */
  total: Decimal;
  /** What the figure covers, printed under it. */
  includes: string;
};

/**
 * The hero with manual trading OFF: wallet cash plus capital with agents,
 * summed exactly. `null` until the wallet has answered, because a total
 * without the user's own cash would be the smaller half passed off as the
 * whole.
 *
 * Positions the user opens themselves are NOT in it: without the trading flag
 * `GET /portfolio` is never asked for, and the sentence says so rather than
 * letting the number imply it. Same for an agent read only from its wallet:
 * its venue account and positions are missing, and named. With trading on,
 * `tradingTotal` is the hero instead (SEN-155).
 */
export function totalValue(
  cash: readonly { symbol: string; amount: string }[] | null,
  agents: readonly AgentCapital[],
): TotalValue | null {
  if (cash === null) return null;
  const stables = cash.filter((balance) => CASH_SYMBOLS.includes(balance.symbol));
  const { read, walletOnly } = splitAgents(agents);
  const total =
    sumDecimals([...stables.map((b) => b.amount), ...read.map((agent) => agent.value)]) ?? '0';

  const what = agents.length === 0 ? 'Your USDC and AUSD' : 'Your USDC and AUSD plus your agents’';
  const missing =
    walletOnly > 0 ? 'your own positions or your agents’ open trades' : 'your own positions';
  const left = unreadAgents(agents.length - read.length);
  return { total, includes: `${what}. Not yet ${missing}.${left === null ? '' : ` ${left}`}` };
}

function splitAgents(agents: readonly AgentCapital[]) {
  const read = agents.flatMap((agent) => (agent.source === 'unread' ? [] : [agent]));
  return { read, walletOnly: read.filter((agent) => agent.source === 'wallet').length };
}

function unreadAgents(unread: number): string | null {
  if (unread === 0) return null;
  return `${unread === 1 ? 'One agent' : `${unread} agents`} couldn’t be read and ${
    unread === 1 ? 'is' : 'are'
  } left out.`;
}

/**
 * Your own side of the total with manual trading on (SEN-155): Portfolio's
 * `holdings`, and whether `/portfolio` answered at all. `unread` means the
 * route refused or failed outright, so `held` has only the wallet and BOTH
 * venue accounts are unknown — named, never summed as zero.
 */
export type OwnHoldings = { held: Holdings; venues: 'read' | 'unread' };

/**
 * Your holdings exactly as the Portfolio tab builds them, or `null` while a
 * read the figure needs is still out (the wallet, `/portfolio`, the tickers),
 * so the hero waits rather than flashing a smaller total and then jumping.
 *
 * `tickers` is `null` until they answer and `[]` when they failed: spot then
 * reads as unpriced and is named, as Portfolio names it.
 */
export function ownHoldings(
  portfolio: { data: Portfolio | null; error: Error | null; unavailable: boolean },
  wallet: readonly WalletAmount[] | null,
  tickers: readonly TickerDto[] | null,
): OwnHoldings | null {
  if (wallet === null || tickers === null) return null;
  const failed = portfolio.error !== null || portfolio.unavailable;
  if (portfolio.data === null && !failed) return null;
  return {
    held: holdings(wallet, portfolio.data, tickers),
    venues: portfolio.data === null ? 'unread' : 'read',
  };
}

/**
 * The hero with manual trading ON (SEN-155): Portfolio's own total — cash in
 * the wallet and parked in Kuru and Perpl, spot at the Kuru price, perps as
 * margin plus unrealised P&L — plus capital with agents. It goes through
 * `allocationParts` and `allocation`, the very functions behind the Portfolio
 * hero, so the two tabs cannot disagree on the same data (`home.test.ts`).
 *
 * That is also why wallet MON counts here, at its Kuru price, where the
 * trading-off total skips it as gas: Portfolio lists it as a spot holding,
 * and Home must add up to what Portfolio shows.
 */
export function tradingTotal(
  own: OwnHoldings | null,
  agents: readonly AgentCapital[],
): TotalValue | null {
  if (own === null) return null;
  const { held, venues } = own;
  const { read, walletOnly } = splitAgents(agents);
  const agentsUsd = read.length > 0 ? (sumDecimals(read.map((agent) => agent.value)) ?? '0') : null;
  const { total } = allocation(allocationParts(held, agentsUsd));

  const venuesLeft =
    venues === 'unread'
      ? ['Kuru', 'Perpl']
      : held.unread.flatMap((s) => (s === 'kuru' ? ['Kuru'] : s === 'perpl' ? ['Perpl'] : []));
  const notes = [
    `Your cash, spot at Kuru prices and perps (margin + P&L)${
      agents.length === 0 ? '' : ', plus your agents’'
    }.`,
    walletOnly > 0 ? 'Not yet your agents’ open trades.' : null,
    // The cash then comes from `/wallet` (see `useUserPortfolio`), which is
    // real, but tokens only `/portfolio` lists may be missing (SEN-123).
    held.unread.includes('wallet') ? 'Some wallet tokens may be left out.' : null,
    held.unpriced.length > 0 ? `Leaves out ${held.unpriced.join(', ')}: no Kuru price.` : null,
    venuesLeft.length > 0
      ? `Leaves out ${venuesLeft.join(' and ')}: ${venuesLeft.length === 1 ? 'it' : 'they'} didn’t answer.`
      : null,
    held.perpsUnknown ? 'Perp positions are left out until Perpl is linked.' : null,
    unreadAgents(agents.length - read.length),
  ];
  return { total, includes: notes.filter((note) => note !== null).join(' ') };
}

/**
 * An agent's stablecoins as a plain decimal — no grouping, every place — so it
 * sums exactly into the total. USDC and AUSD count as one quote unit, as the
 * summaries count P&L.
 */
export function stableAmount(
  balances: Readonly<Record<string, bigint>>,
  tokens: readonly { symbol: string; decimals: number }[],
): Decimal {
  const decimals = Math.max(0, ...tokens.map((token) => token.decimals));
  const total = tokens.reduce(
    (sum, token) => sum + (balances[token.symbol] ?? 0n) * 10n ** BigInt(decimals - token.decimals),
    0n,
  );
  return formatFixedAtoms(total, decimals, { group: false });
}

/**
 * What the agents realised over the last 24 hours, summed from the summaries
 * (USDC and AUSD as one unit, so it reads in ≈ $). `null` with no summaries —
 * no agents, or an API that predates them — so the hero shows no change line
 * rather than a zero it does not know.
 */
export function realisedToday(
  summaries: ReadonlyMap<string, Pick<AgentSummary, 'pnl'>>,
): { value: Decimal; label: string; tone: 'up' | 'down' | null } | null {
  if (summaries.size === 0) return null;
  const value = sumDecimals([...summaries.values()].map((s) => s.pnl.last24h)) ?? '0';
  const tone = pnlTone(value);
  if (tone === null) return { value, label: 'Agents flat today', tone };
  // `signedPnl` gives `+18.22` / `−4.1`; the `$` goes between sign and digits.
  const signed = signedPnl(value);
  return {
    value,
    label: `${signed.slice(0, 1)}$${signed.slice(1)} realised by agents today`,
    tone,
  };
}

/**
 * The hero's area chart: the agents' realised P&L across the last 24 hours,
 * one step per settled trade, ending on `end` (the summaries' figure, so the
 * line lands on the number printed above it).
 *
 * There is no equity history on the wire, so this is NOT the total's history
 * and the screen labels it. It is built backwards from `end` because the
 * activity page (50 events at most) may not reach the start of the window:
 * the start is then whatever the page could not explain, not a zero that
 * would draw a climb nobody made. Only SEN-22 verdicts count, never the
 * venue's `close` before them (both carry a P&L; counting both doubles it).
 *
 * `null` when no trade settled in the window: a flat line would claim a day
 * of doing nothing where the page may simply not reach.
 */
export function realisedSeries(
  events: readonly ActivityEvent[],
  end: Decimal | null,
  now: number,
): Decimal[] | null {
  // Mapped one event at a time: `seq` is per agent, so the batch sort inside
  // `toLedgerEntries` would interleave a mixed page wrongly. Time orders it.
  const settled = events
    .flatMap((event) => toLedgerEntries([event]))
    .flatMap((entry) =>
      entry.kind === 'verdict' &&
      entry.origin === 'verdict' &&
      entry.pnl !== null &&
      entry.at > now - DAY_MS &&
      entry.at <= now
        ? [{ at: entry.at, pnl: entry.pnl }]
        : [],
    )
    .sort((a, b) => a.at - b.at);
  if (settled.length === 0) return null;
  const points = [end ?? sumDecimals(settled.map((s) => s.pnl)) ?? '0'];
  for (let i = settled.length - 1; i >= 0; i--) {
    points.unshift(sumDecimals([points[0]!, negate(settled[i]!.pnl)]) ?? points[0]!);
  }
  return points;
}

function negate(value: string): string {
  const trimmed = value.trim().replace(/^\+/, '');
  return trimmed.startsWith('-') ? trimmed.slice(1) : `-${trimmed}`;
}

/** `Good morning` / `Good afternoon` / `Good evening`, by the device's hour. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning';
  if (hour >= 12 && hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** One agent's card under "Your agents at work": its last move and its day. */
export type AgentAtWork = {
  move: Move | null;
  /** `+18.22 USDC`, `−4.10 AUSD`, `≈ +$3.10` for an agent on both venues. */
  pnl: { label: string; tone: 'up' | 'down' | null } | null;
};

/**
 * The card's two lines. The move is the Agents tab's own sentence
 * (`describeMove`), so an agent reads the same on both. The P&L names its
 * quote currency when the mandate has one venue; a Kuru and Perpl agent's
 * figure mixes USDC and AUSD, so it is only ≈ $.
 */
export function atWork(
  agent: Pick<Agent, 'mandate'>,
  summary: Pick<AgentSummary, 'pnl' | 'lastEvent'> | undefined,
): AgentAtWork {
  const move = summary?.lastEvent ? describeMove(summary.lastEvent) : null;
  if (!summary) return { move, pnl: null };
  const value = summary.pnl.last24h;
  const tone = pnlTone(value);
  const signed = tone === null ? '0.00' : signedPnl(value);
  const venues = agent.mandate.venues;
  const unit = venues.length === 1 ? (venues[0] === 'kuru' ? 'USDC' : 'AUSD') : null;
  // A flat day has no sign to put the $ after: "≈ $0.00", not "≈ 0$.00".
  const dollars = tone === null ? '$0.00' : `${signed.slice(0, 1)}$${signed.slice(1)}`;
  return {
    move,
    pnl: { label: unit !== null ? `${signed} ${unit}` : `≈ ${dollars}`, tone },
  };
}

// ---------------------------------------------------------------------------
// Markets on Home

/** What the ticker marquee draws for one market (`ui/trading.tsx`'s `TickerItem`). */
export type HomeTicker = {
  symbol: string;
  price: Decimal;
  tick?: Decimal;
  changePct: number | null;
};

/** The strip's label: the base for spot (`MON`), the symbol for perps (`BTC-PERP`). */
export function marketLabel(market: Pick<MarketDto, 'kind' | 'symbol' | 'base'>): string {
  return market.kind === 'perp' ? market.symbol : market.base;
}

/**
 * The ticker marquee: every market with a price, busiest first (24h quote
 * volume), so the strip leads with what trades. With about eleven markets
 * the whole list fits, and a hand-picked "majors" cut would go stale.
 */
export function tickerItems(markets: readonly MarketDto[], tickers: TickerIndex): HomeTicker[] {
  return sortMarkets(markets, 'volume', tickers).flatMap((market) => {
    const price = priceOf(market, tickers);
    if (price === null) return [];
    return [
      {
        symbol: marketLabel(market),
        price,
        tick: market.tickSize,
        changePct: asPercent(changeOf(market, tickers)),
      },
    ];
  });
}

/** The watchlist: the markets starred on this device (`localLists.ts`), in the list's order. */
export function watchlist(
  markets: readonly MarketDto[],
  favourites: ReadonlySet<MarketKey>,
): MarketDto[] {
  return markets.filter((market) => favourites.has(marketKey(market)));
}

/**
 * Biggest moves today: the list sorted by the size of the 24h move, either
 * way. With this few markets a "trending" score would be theatre (the study's
 * note). A market with no change is left out rather than read as flat.
 */
export function biggestMoves(
  markets: readonly MarketDto[],
  tickers: TickerIndex,
  limit = 3,
): MarketDto[] {
  return markets
    .flatMap((market, i) => {
      const change = changeOf(market, tickers);
      return change === null ? [] : [{ market, i, size: Math.abs(change) }];
    })
    .sort((a, b) => b.size - a.size || a.i - b.i)
    .slice(0, limit)
    .map(({ market }) => market);
}

export type AgentMarket = { market: MarketDto; agents: number; caption: string };

/**
 * "What your agents are trading": each listed market an ACTIVE agent's
 * mandate names, with how many agents name it, most shared first. Counts, not
 * P&L, so it reads as interest rather than advice (the study's note).
 *
 * From mandates, not positions: positions need the portfolio route, which is
 * not deployed yet, while what an agent may trade is always known. A Kuru
 * mandate names OrderBook addresses (mapped back with `marketFor`); a Perpl
 * one names the venue's symbol or the base, matched case-insensitively.
 */
export function agentMarkets(
  agents: readonly Pick<Agent, 'status' | 'mandate'>[],
  markets: readonly MarketDto[],
): AgentMarket[] {
  const counts = new Map<MarketKey, number>();
  for (const agent of agents) {
    if (agent.status !== 'active') continue;
    const names = {
      kuru: agent.mandate.kuru.markets.map((address) => marketFor(address)?.symbol ?? address),
      perpl: agent.mandate.perpl.markets,
    };
    for (const market of markets) {
      const wanted = new Set(names[market.venue].map((name) => name.toLowerCase()));
      const forms = [market.symbol, market.venueSymbol];
      if (market.venue === 'perpl') forms.push(market.base);
      if (forms.some((form) => wanted.has(form.toLowerCase()))) {
        counts.set(marketKey(market), (counts.get(marketKey(market)) ?? 0) + 1);
      }
    }
  }
  return markets
    .flatMap((market, i) => {
      const n = counts.get(marketKey(market)) ?? 0;
      return n === 0 ? [] : [{ market, i, n }];
    })
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(({ market, n }) => ({ market, agents: n, caption: n === 1 ? '1 agent' : `${n} agents` }));
}

/**
 * The idle-cash nudge's sentence, or `null` when nothing is idle. Wallet cash
 * is idle by definition here: an agent's capital lives in the agent's own
 * wallet, and the user's own orders are not on Home until `GET /portfolio`.
 */
export function idleCash(
  cash: readonly { symbol: string; raw: bigint; decimals: number }[] | null,
): string | null {
  if (cash === null) return null;
  const parts = CASH_SYMBOLS.flatMap((symbol) => {
    const balance = cash.find((b) => b.symbol === symbol);
    if (!balance || balance.raw <= 0n) return [];
    return [`${formatFixedAtoms(balance.raw, balance.decimals, { places: 2 })} ${symbol}`];
  });
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} ${parts.length === 1 ? 'is' : 'are'} sitting idle.`;
}
