/**
 * What the Markets tab and search show (SEN-110, plan U-4): chip filters,
 * themes, sorting and one search box over markets and agents. Plain node, no
 * React Native, so `select.test.ts` runs without a device; screens only lay
 * out what comes back.
 *
 * The market set is small (four Kuru pairs, a handful of Perpl perps), so
 * everything here is a linear pass; no index is worth its upkeep.
 */
import type { MarketDto, TickerDto, VenueId } from './api.ts';

/** `kuru:MON-USDC`. Symbols repeat across venues (MON spot vs MON perp), so the venue is part of it. */
export type MarketKey = `${VenueId}:${string}`;

export function marketKey(market: { venue: VenueId; symbol: string }): MarketKey {
  return `${market.venue}:${market.symbol}`;
}

export type TickerIndex = ReadonlyMap<MarketKey, TickerDto>;

export function indexTickers(tickers: readonly TickerDto[]): TickerIndex {
  return new Map(tickers.map((ticker) => [marketKey(ticker), ticker]));
}

/** 24h change as a fraction, or `null` when the venue has none to report. */
export function changeOf(market: MarketDto, tickers: TickerIndex): number | null {
  const raw = tickers.get(marketKey(market))?.change24hPct;
  if (raw === null || raw === undefined) return null;
  const value = Number(raw);
  // A ratio for ordering and display only; money never goes through here.
  return Number.isFinite(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export type MarketFilter = 'all' | 'favourites' | 'spot' | 'perps' | 'gainers' | 'losers';

export const MARKET_FILTERS: readonly { id: MarketFilter; label: string }[] = [
  { id: 'favourites', label: 'Favourites' },
  { id: 'all', label: 'All' },
  { id: 'spot', label: 'Spot' },
  { id: 'perps', label: 'Perps' },
  { id: 'gainers', label: 'Gainers' },
  { id: 'losers', label: 'Losers' },
];

/**
 * The chip filters. Gainers and losers come back ordered by the size of the
 * move (that is the question the chip asks); the others keep the input order,
 * so `sortMarkets` stays the screen's choice. A market without a 24h change is
 * neither a gainer nor a loser: flat and unknown are not a direction.
 */
export function filterMarkets(
  markets: readonly MarketDto[],
  filter: MarketFilter,
  { tickers, favourites }: { tickers: TickerIndex; favourites: ReadonlySet<string> },
): MarketDto[] {
  switch (filter) {
    case 'all':
      return [...markets];
    case 'favourites':
      return markets.filter((market) => favourites.has(marketKey(market)));
    case 'spot':
      return markets.filter((market) => market.kind === 'spot');
    case 'perps':
      return markets.filter((market) => market.kind === 'perp');
    case 'gainers':
    case 'losers': {
      const sign = filter === 'gainers' ? 1 : -1;
      return markets
        .map((market) => ({ market, change: changeOf(market, tickers) }))
        .filter(({ change }) => change !== null && change * sign > 0)
        .sort((a, b) => (b.change! - a.change!) * sign)
        .map(({ market }) => market);
    }
  }
}

export type MarketSort = 'change' | 'volume' | 'symbol';

/**
 * The list's sort. Descending for `change` and `volume`, and markets without
 * the number go last rather than being read as zero.
 */
export function sortMarkets(
  markets: readonly MarketDto[],
  sort: MarketSort,
  tickers: TickerIndex,
): MarketDto[] {
  if (sort === 'symbol') {
    return [...markets].sort(
      (a, b) => a.symbol.localeCompare(b.symbol) || a.venue.localeCompare(b.venue),
    );
  }
  const valueOf = (market: MarketDto): number | null => {
    if (sort === 'change') return changeOf(market, tickers);
    const raw = tickers.get(marketKey(market))?.quoteVolume24h;
    const value = raw === null || raw === undefined ? NaN : Number(raw);
    return Number.isFinite(value) ? value : null;
  };
  return [...markets]
    .map((market, i) => ({ market, i, value: valueOf(market) }))
    .sort((a, b) => {
      if (a.value === null || b.value === null) {
        return a.value === b.value ? a.i - b.i : a.value === null ? 1 : -1;
      }
      return b.value - a.value || a.i - b.i;
    })
    .map(({ market }) => market);
}

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type ThemeId = 'monad' | 'majors' | 'gold';

/**
 * Themes are sets of BASE assets, so a theme gathers spot and perp alike
 * ("Monad natives" is MON spot + MON-PERP) and only ever lists markets that
 * exist. The study is explicit that a theme must not promise pairs we don't
 * have, hence "Gold", not "Gold & stables".
 */
export const THEMES: readonly { id: ThemeId; name: string; bases: readonly string[] }[] = [
  { id: 'monad', name: 'Monad natives', bases: ['MON', 'WMON'] },
  { id: 'majors', name: 'Majors', bases: ['BTC', 'CBBTC', 'WBTC', 'ETH', 'WETH', 'SOL'] },
  { id: 'gold', name: 'Gold', bases: ['XAUT', 'PAXG', 'XAU'] },
];

export type Theme = {
  id: ThemeId;
  name: string;
  markets: MarketDto[];
  /** Mean 24h change of the markets that report one, as a fraction; `null` if none do. */
  change: number | null;
};

export function inTheme(market: MarketDto, id: ThemeId): boolean {
  const theme = THEMES.find((t) => t.id === id);
  return theme !== undefined && theme.bases.includes(market.base.toUpperCase());
}

/** The theme cards: only themes with at least one market, in `THEMES` order. */
export function themesFor(markets: readonly MarketDto[], tickers: TickerIndex): Theme[] {
  return THEMES.map(({ id, name }) => {
    const members = markets.filter((market) => inTheme(market, id));
    const changes = members
      .map((market) => changeOf(market, tickers))
      .filter((change): change is number => change !== null);
    const change =
      changes.length === 0 ? null : changes.reduce((sum, c) => sum + c, 0) / changes.length;
    return { id, name, markets: members, change };
  }).filter((theme) => theme.markets.length > 0);
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * What search needs from an agent. The caller maps its own agents (yours,
 * the board's) onto this, `markets` as symbols such as `MON-USDC` or
 * `ETH-PERP`, so this module stays free of both agent types.
 */
export type SearchableAgent = { name: string; markets: readonly string[] };

export type SearchResults<A> = { markets: MarketDto[]; agents: A[] };

/**
 * One box over markets and agents. Markets match on symbol, base or the
 * venue's own symbol, best match first (exact, then prefix, then contains).
 * Agents match by name, and also by what they trade: "mon" finds an agent
 * named Range Hunter because it trades MON-USDC — the study's own example.
 * An empty query matches nothing; the screen shows recents instead.
 */
export function search<A extends SearchableAgent>(
  query: string,
  markets: readonly MarketDto[],
  agents: readonly A[],
): SearchResults<A> {
  const q = normalise(query);
  if (q === '') return { markets: [], agents: [] };

  const marketHits = markets
    .map((market, i) => ({
      market,
      i,
      score: best([market.symbol, market.base, market.venueSymbol], q),
    }))
    .filter((hit) => hit.score !== null)
    .sort((a, b) => a.score! - b.score! || a.i - b.i)
    .map(({ market }) => market);

  // Symbols of the matched markets, so an agent trading one is found even
  // when its mandate names the market by a form the query did not spell.
  const matched = new Set(
    marketHits.flatMap((market) => [market.symbol, market.venueSymbol].map(normalise)),
  );

  const agentHits = agents
    .map((agent, i) => {
      const byName = best([agent.name], q);
      const byMarket = agent.markets.some(
        (m) => matched.has(normalise(m)) || best([m], q) !== null,
      );
      // Name matches rank above market matches: someone typing a name wants that agent.
      const score = byName ?? (byMarket ? 3 : null);
      return { agent, i, score };
    })
    .filter((hit) => hit.score !== null)
    .sort((a, b) => a.score! - b.score! || a.i - b.i)
    .map(({ agent }) => agent);

  return { markets: marketHits, agents: agentHits };
}

function normalise(text: string): string {
  return text.trim().toLowerCase();
}

/** 0 exact, 1 prefix (or a word prefix), 2 contains, `null` no match. */
function best(fields: readonly string[], q: string): number | null {
  let score: number | null = null;
  for (const field of fields) {
    const f = normalise(field);
    const s =
      f === q
        ? 0
        : f.startsWith(q) || f.split(/[\s\-_/.]+/).some((word) => word.startsWith(q))
          ? 1
          : f.includes(q)
            ? 2
            : null;
    if (s !== null && (score === null || s < score)) score = s;
  }
  return score;
}
