/**
 * What the Markets tab and search print (SEN-111, plan U-5), on top of the
 * filters, themes and search in `select.ts`: a row's venue line and price, the
 * sparkline's points, the recents and favourites lists, and the agents search
 * looks through. Plain node, no React Native, so `marketsView.test.ts` runs
 * without a device; the screens only lay out.
 */
import type { Agent, AgentSummary, Leaderboard } from '../agents/api.ts';
import { roiLabel, venueLabel, wonLabel } from '../agents/leaderboard.ts';
import { countsSince } from '../agents/cockpit.ts';
import { marketFor } from '../agents/mandate.ts';
import { glyphFor } from '../ui/tradingFormat.ts';

import type { Decimal, KlineDto, MarketDto, MarketsResponseDto, VenueId } from './api.ts';
import { marketKey, type MarketKey, type SearchableAgent, type TickerIndex } from './select.ts';

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

const VENUE_NAME: Record<VenueId, string> = { kuru: 'Kuru', perpl: 'Perpl' };

/**
 * `Kuru spot · USDC` / `Perpl · AUSD`. The quote currency is always named:
 * the two venues price in different dollars, and a Perpl figure must never
 * read as USDC.
 */
export function venueLine(market: MarketDto): string {
  const venue = VENUE_NAME[market.venue];
  return market.kind === 'spot' ? `${venue} spot · ${market.quote}` : `${venue} · ${market.quote}`;
}

/**
 * The price a row shows: the last trade, else the perp's mark, else the mid.
 * `null` when the venue quoted none of them (the row prints a dash).
 */
export function priceOf(market: MarketDto, tickers: TickerIndex): Decimal | null {
  const ticker = tickers.get(marketKey(market));
  if (ticker === undefined) return null;
  return ticker.last ?? ticker.mark ?? ticker.mid ?? null;
}

/** `select.ts` speaks fractions (0.0241); the kit prints percent (2.41). */
export function asPercent(fraction: number | null): number | null {
  return fraction === null ? null : fraction * 100;
}

/**
 * The sparkline: the 30 daily closes, with the last one replaced by the live
 * price. The last candle is the day still in progress, so its close is only
 * as fresh as the kline fetch — which is not polled — while the price beside
 * the line is; swapping it keeps the end dot on the number printed next to it.
 */
export function sparkPoints(klines: readonly KlineDto[], live: Decimal | null): Decimal[] {
  const closes = klines.map((kline) => kline.close);
  if (live !== null && closes.length > 0) closes[closes.length - 1] = live;
  return closes;
}

/**
 * The venues `/markets` could not reach, by name: a partial list must say
 * which half is missing rather than look complete.
 */
export function downVenues(response: MarketsResponseDto): string[] {
  return response.venues.filter((venue) => !venue.ok).map((venue) => VENUE_NAME[venue.venue]);
}

/**
 * The stones on a theme card: one per distinct glyph, at most three, so
 * "Monad natives" (MON spot + MON-PERP) shows one M rather than two.
 */
export function themeSymbols(markets: readonly MarketDto[], max = 3): string[] {
  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const market of markets) {
    const { letter, tint } = glyphFor(market.base);
    const stone = `${letter}${tint}`;
    if (seen.has(stone)) continue;
    seen.add(stone);
    symbols.push(market.base);
    if (symbols.length === max) break;
  }
  return symbols;
}

// ---------------------------------------------------------------------------
// Recents and favourites (stored on the device by `localLists.ts`)
// ---------------------------------------------------------------------------

export type Recent =
  | { kind: 'market'; venue: VenueId; symbol: string; label: string }
  | { kind: 'agent'; id: string; own: boolean; label: string };

export const MAX_RECENTS = 6;

function recentId(recent: Recent): string {
  return recent.kind === 'market' ? `m:${recent.venue}:${recent.symbol}` : `a:${recent.id}`;
}

/** Newest first, no duplicates: opening something again moves it to the front. */
export function pushRecent(list: readonly Recent[], entry: Recent, max = MAX_RECENTS): Recent[] {
  const id = recentId(entry);
  return [entry, ...list.filter((recent) => recentId(recent) !== id)].slice(0, max);
}

/**
 * Whatever is stored, back as recents. Anything malformed is dropped rather
 * than thrown: a corrupt list costs the user their recents, not the screen.
 */
export function parseRecents(raw: string | null): Recent[] {
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(isRecent).slice(0, MAX_RECENTS);
}

function isRecent(value: unknown): value is Recent {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  if (typeof r.label !== 'string') return false;
  if (r.kind === 'market') {
    return (r.venue === 'kuru' || r.venue === 'perpl') && typeof r.symbol === 'string';
  }
  return r.kind === 'agent' && typeof r.id === 'string' && typeof r.own === 'boolean';
}

/** Favourites are market keys (`kuru:MON-USDC`), the same keys `filterMarkets` checks. */
export function parseFavourites(raw: string | null): Set<MarketKey> {
  const parsed = safeJson(raw);
  if (!Array.isArray(parsed)) return new Set();
  return new Set(
    parsed.filter(
      (key): key is MarketKey => typeof key === 'string' && /^(kuru|perpl):\S+$/.test(key),
    ),
  );
}

export function toggleFavourite(
  favourites: ReadonlySet<MarketKey>,
  key: MarketKey,
): Set<MarketKey> {
  const next = new Set(favourites);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

function safeJson(raw: string | null): unknown {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Agents in search
// ---------------------------------------------------------------------------

export type SearchAgent = SearchableAgent & {
  id: string;
  /** Yours opens its screen; someone else's opens its Ledger. */
  own: boolean;
  /** `Yours · won 6 of 9 · Kuru`, `Won 7 of 10 · Kuru · Perpl`. Always with its sample. */
  caption: string;
  /** Board ROI beside the name (`+24.1%`), for agents the board has a number for. */
  roi: { label: string; up: boolean } | null;
};

/**
 * Your agents first, then the board's, each once. Search matches an agent by
 * what it trades, so each one carries its markets as symbols: a Kuru mandate
 * names OrderBook addresses (mapped back with `marketFor`), Perpl's names
 * symbols. The board only gives a one-line mandate summary
 * (`Kuru MON-USDC · Perpl BTC · max 50 per order`), so its markets are read
 * out of that line.
 *
 * `board` is `null` when the indexer is unconfigured or unreachable: then the
 * list is yours alone, never padded with rows that have no numbers.
 */
export function searchAgents(
  agents: readonly Agent[],
  summaries: ReadonlyMap<string, AgentSummary>,
  board: Leaderboard | null,
): SearchAgent[] {
  const rows = board === null ? [] : [...board.ranked, ...board.tooFewTrades];
  const onBoard = new Map(rows.map((row) => [row.agentId, row]));
  const own: SearchAgent[] = agents.map((agent) => {
    const row = onBoard.get(agent.id);
    const kuru = agent.mandate.kuru.markets.map((address) => marketFor(address)?.symbol ?? address);
    const record =
      row !== undefined && row.n > 0
        ? wonLabel(row.wins, row.n)
        : summaryLine(summaries.get(agent.id));
    const parts = ['Yours', agent.status === 'revoked' ? 'revoked' : record];
    return {
      id: agent.id,
      name: agent.name,
      markets: [...kuru, ...agent.mandate.perpl.markets],
      own: true,
      caption: parts.filter((part) => part !== '').join(' · '),
      roi: roiOf(row?.roi ?? null),
    };
  });
  const mine = new Set(agents.map((agent) => agent.id));
  const others: SearchAgent[] = rows
    .filter((row) => !mine.has(row.agentId))
    .map((row) => ({
      id: row.agentId,
      name: row.name,
      markets: boardMarkets(row.mandate),
      own: false,
      caption: `${capitalise(wonLabel(row.wins, row.n))} · ${venueLabel(row.venues)}`,
      roi: roiOf(row.roi),
    }));
  return [...own, ...others];
}

function summaryLine(summary: AgentSummary | undefined): string {
  if (summary === undefined) return '';
  const count = summary.trades === 1 ? '1 trade' : `${summary.trades} trades`;
  return `${count}${countsSince(summary)}`;
}

function roiOf(roi: number | null): SearchAgent['roi'] {
  return roi === null ? null : { label: roiLabel(roi), up: roi >= 0 };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The words of a board mandate line that name markets (`MON-USDC`, `BTC`), not the prose around them. */
export function boardMarkets(line: string): string[] {
  const words = line.split(/[\s,·]+/).filter((word) => word !== '');
  return words.filter(
    (word) => /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(word) || /^[A-Z][A-Z0-9]{1,9}$/.test(word),
  );
}

/**
 * The agents section's heading: `Agents trading MON` when the query found a
 * market (the agents are listed because of it), plain `Agents` otherwise.
 */
export function agentsHeading(marketHits: readonly MarketDto[]): string {
  const first = marketHits[0];
  return first === undefined ? 'Agents' : `Agents trading ${first.base}`;
}

/**
 * The query's first occurrence in `text`, as runs to render with the matched
 * one highlighted. Case-insensitive; no match is one plain run.
 */
export function highlight(text: string, query: string): { text: string; hit: boolean }[] {
  const q = query.trim().toLowerCase();
  const at = q === '' ? -1 : text.toLowerCase().indexOf(q);
  if (at === -1) return [{ text, hit: false }];
  return [
    { text: text.slice(0, at), hit: false },
    { text: text.slice(at, at + q.length), hit: true },
    { text: text.slice(at + q.length), hit: false },
  ].filter((run) => run.text !== '');
}
