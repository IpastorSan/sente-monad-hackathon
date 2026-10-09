/**
 * The Markets tab's choices (SEN-110): chip filters, themes, sort and the one
 * search box over markets and agents. Plain node, no device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MarketDto, TickerDto } from './api.ts';
import {
  filterMarkets,
  indexTickers,
  marketKey,
  search,
  sortMarkets,
  themesFor,
} from './select.ts';

function market(
  venue: MarketDto['venue'],
  symbol: string,
  base: string,
  kind: MarketDto['kind'],
): MarketDto {
  return {
    venue,
    symbol,
    venueSymbol: symbol.replace('-', ''),
    kind,
    base,
    quote: venue === 'kuru' ? 'USDC' : 'AUSD',
    tickSize: '0.0001',
    stepSize: '0.01',
    minSize: '0.01',
    minNotional: venue === 'kuru' ? '1' : null,
    maxLeverage: kind === 'perp' ? 20 : null,
    marginMode: kind === 'perp' ? 'isolated' : null,
    makerFee: '0',
    takerFee: '0.0007',
  };
}

function ticker(
  m: MarketDto,
  change24hPct: string | null,
  quoteVolume24h: string | null = null,
): TickerDto {
  return {
    venue: m.venue,
    symbol: m.symbol,
    quote: m.quote,
    last: '1',
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid: null,
    open24h: null,
    high24h: null,
    low24h: null,
    change24h: null,
    change24hPct,
    quoteVolume24h,
    funding: null,
    stale: false,
    asOf: 0,
  };
}

const MON = market('kuru', 'MON-USDC', 'MON', 'spot');
const MON_PERP = market('perpl', 'MON-PERP', 'MON', 'perp');
const WBTC = market('kuru', 'WBTC-USDC', 'WBTC', 'spot');
const BTC_PERP = market('perpl', 'BTC-PERP', 'BTC', 'perp');
const ETH_PERP = market('perpl', 'ETH-PERP', 'ETH', 'perp');
const XAUT = market('kuru', 'XAUT-USDC', 'XAUT', 'spot');
const ALL = [MON, MON_PERP, WBTC, BTC_PERP, ETH_PERP, XAUT];

const TICKERS = indexTickers([
  ticker(MON, '0.0241', '1000'),
  ticker(MON_PERP, '0.0238', '5000'),
  ticker(WBTC, '0.0062'),
  ticker(BTC_PERP, '0.0058', '9000'),
  ticker(ETH_PERP, '-0.0096', '3000'),
  ticker(XAUT, null),
]);

const NONE = new Set<string>();

test('marketKey keeps venues apart: MON spot and MON perp are two markets', () => {
  assert.notEqual(marketKey(MON), marketKey(MON_PERP));
  assert.equal(marketKey(MON), 'kuru:MON-USDC');
});

test('spot and perps split by kind, keeping order', () => {
  const opts = { tickers: TICKERS, favourites: NONE };
  assert.deepEqual(filterMarkets(ALL, 'spot', opts), [MON, WBTC, XAUT]);
  assert.deepEqual(filterMarkets(ALL, 'perps', opts), [MON_PERP, BTC_PERP, ETH_PERP]);
  assert.deepEqual(filterMarkets(ALL, 'all', opts), ALL);
});

test('favourites are keyed by venue as well as symbol', () => {
  const favourites = new Set([marketKey(MON_PERP)]);
  assert.deepEqual(filterMarkets(ALL, 'favourites', { tickers: TICKERS, favourites }), [MON_PERP]);
});

test('gainers are biggest first; losers most negative first; no change is neither', () => {
  const opts = { tickers: TICKERS, favourites: NONE };
  assert.deepEqual(filterMarkets(ALL, 'gainers', opts), [MON, MON_PERP, WBTC, BTC_PERP]);
  assert.deepEqual(filterMarkets(ALL, 'losers', opts), [ETH_PERP]);
  // XAUT has no 24h change, and a market with no ticker at all is excluded too.
  const orphan = market('kuru', 'WETH-USDC', 'WETH', 'spot');
  assert.deepEqual(filterMarkets([orphan], 'gainers', opts), []);
});

test('sort by change or volume puts markets without the number last', () => {
  assert.deepEqual(sortMarkets(ALL, 'change', TICKERS), [
    MON,
    MON_PERP,
    WBTC,
    BTC_PERP,
    ETH_PERP,
    XAUT,
  ]);
  assert.deepEqual(sortMarkets(ALL, 'volume', TICKERS), [
    BTC_PERP,
    MON_PERP,
    ETH_PERP,
    MON,
    WBTC,
    XAUT,
  ]);
  assert.deepEqual(
    sortMarkets(ALL, 'symbol', TICKERS).map((m) => m.symbol),
    ['BTC-PERP', 'ETH-PERP', 'MON-PERP', 'MON-USDC', 'WBTC-USDC', 'XAUT-USDC'],
  );
});

test('themes gather spot and perp by base and skip empty ones', () => {
  const themes = themesFor(ALL, TICKERS);
  assert.deepEqual(
    themes.map((t) => [t.id, t.markets.map(marketKey)]),
    [
      ['monad', ['kuru:MON-USDC', 'perpl:MON-PERP']],
      ['majors', ['kuru:WBTC-USDC', 'perpl:BTC-PERP', 'perpl:ETH-PERP']],
      ['gold', ['kuru:XAUT-USDC']],
    ],
  );
  assert.ok(Math.abs(themes[0]!.change! - 0.02395) < 1e-9);
  // Gold's only market reports no change: the card says so rather than 0%.
  assert.equal(themes[2]!.change, null);
  assert.deepEqual(
    themesFor([MON], TICKERS).map((t) => t.id),
    ['monad'],
  );
});

type TestAgent = { id: string; name: string; markets: string[] };
const RANGE_HUNTER: TestAgent = { id: 'a1', name: 'Range Hunter', markets: ['MON-USDC'] };
const TENGEN: TestAgent = { id: 'a2', name: 'Tengen', markets: ['ETH-PERP', 'WBTC-USDC'] };
const MON_MAXI: TestAgent = { id: 'a3', name: 'mon maxi', markets: ['BTC-PERP'] };
const AGENTS = [RANGE_HUNTER, TENGEN, MON_MAXI];

test('search: empty query shows nothing (the screen shows recents)', () => {
  assert.deepEqual(search('  ', ALL, AGENTS), { markets: [], agents: [] });
});

test('search: markets by symbol, base or venue symbol, best match first', () => {
  assert.deepEqual(search('mon', ALL, []).markets, [MON, MON_PERP]);
  assert.deepEqual(search('btc', ALL, []).markets, [BTC_PERP, WBTC]);
  assert.deepEqual(search('ETHPERP', ALL, []).markets, [ETH_PERP]);
  assert.deepEqual(search('perp', ALL, []).markets, [MON_PERP, BTC_PERP, ETH_PERP]);
});

test('search: agents by name first, then by the markets they trade', () => {
  // "mon" finds Range Hunter because it trades MON-USDC; the name match ranks first.
  assert.deepEqual(search('mon', ALL, AGENTS).agents, [MON_MAXI, RANGE_HUNTER]);
  assert.deepEqual(search('teng', ALL, AGENTS).agents, [TENGEN]);
  // Matching a market by its venue symbol still finds agents that name it by symbol.
  assert.deepEqual(search('wbtcusdc', ALL, AGENTS).agents, [TENGEN]);
  assert.deepEqual(search('doge', ALL, AGENTS), { markets: [], agents: [] });
});
