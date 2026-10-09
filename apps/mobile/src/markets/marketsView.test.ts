/**
 * What the Markets tab and search print (SEN-111): venue lines, prices,
 * sparkline points, recents, favourites and the agents search looks through.
 * Plain node, no device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Agent, AgentSummary, Leaderboard, LeaderboardRow } from '../agents/api.ts';

import type { KlineDto, MarketDto, TickerDto } from './api.ts';
import {
  agentsHeading,
  asPercent,
  boardMarkets,
  downVenues,
  highlight,
  parseFavourites,
  parseRecents,
  priceOf,
  pushRecent,
  searchAgents,
  sparkPoints,
  themeSymbols,
  toggleFavourite,
  venueLine,
  type Recent,
} from './marketsView.ts';
import { indexTickers, search } from './select.ts';

function market(venue: MarketDto['venue'], symbol: string, base: string): MarketDto {
  const perp = venue === 'perpl';
  return {
    venue,
    symbol,
    venueSymbol: symbol.replace('-', ''),
    kind: perp ? 'perp' : 'spot',
    base,
    quote: perp ? 'AUSD' : 'USDC',
    tickSize: '0.0001',
    stepSize: '0.01',
    minSize: '0.01',
    minNotional: perp ? null : '1',
    maxLeverage: perp ? 10 : null,
    marginMode: perp ? 'isolated' : null,
    makerFee: '0',
    takerFee: '0.0007',
  };
}

function ticker(
  m: MarketDto,
  prices: Partial<Pick<TickerDto, 'last' | 'mark' | 'mid'>>,
): TickerDto {
  return {
    venue: m.venue,
    symbol: m.symbol,
    quote: m.quote,
    last: null,
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid: null,
    open24h: null,
    high24h: null,
    low24h: null,
    change24h: null,
    change24hPct: null,
    quoteVolume24h: null,
    funding: null,
    stale: false,
    asOf: 0,
    ...prices,
  };
}

const MON = market('kuru', 'MON-USDC', 'MON');
const MON_PERP = market('perpl', 'MON-PERP', 'MON');
const BTC_PERP = market('perpl', 'BTC-PERP', 'BTC');
const WBTC = market('kuru', 'WBTC-USDC', 'WBTC');
const ETH_PERP = market('perpl', 'ETH-PERP', 'ETH');

test('the venue line always names the quote currency', () => {
  assert.equal(venueLine(MON), 'Kuru spot · USDC');
  assert.equal(venueLine(MON_PERP), 'Perpl · AUSD');
});

test('a row prices from last, then mark, then mid, and says nothing without a ticker', () => {
  const tickers = indexTickers([
    ticker(MON, { last: '0.9812', mid: '0.98' }),
    ticker(MON_PERP, { mark: '0.9809', mid: '0.98' }),
    ticker(BTC_PERP, { mid: '64188.5' }),
  ]);
  assert.equal(priceOf(MON, tickers), '0.9812');
  assert.equal(priceOf(MON_PERP, tickers), '0.9809');
  assert.equal(priceOf(BTC_PERP, tickers), '64188.5');
  assert.equal(priceOf(WBTC, tickers), null);
});

test('fractions become the percent the kit prints', () => {
  assert.equal(asPercent(0.0241), 2.41);
  assert.equal(asPercent(null), null);
});

function kline(close: string): KlineDto {
  return {
    openTime: 0,
    closeTime: 0,
    open: close,
    high: close,
    low: close,
    close,
    volume: '0',
    quoteVolume: null,
  };
}

test('the sparkline ends on the live price, not the fetched close', () => {
  const klines = [kline('1'), kline('2'), kline('3')];
  assert.deepEqual(sparkPoints(klines, '3.5'), ['1', '2', '3.5']);
  assert.deepEqual(sparkPoints(klines, null), ['1', '2', '3']);
  assert.deepEqual(sparkPoints([], '3.5'), []);
  assert.equal(klines[2]!.close, '3', 'the cached klines are not mutated');
});

test('a partial /markets answer names the venue that is missing', () => {
  assert.deepEqual(
    downVenues({
      markets: [MON],
      venues: [
        { venue: 'kuru', ok: true },
        { venue: 'perpl', ok: false, error: 'timeout' },
      ],
      asOf: 0,
    }),
    ['Perpl'],
  );
});

test('a theme card shows one stone per asset, wrappers included, at most three', () => {
  assert.deepEqual(themeSymbols([MON, MON_PERP]), ['MON']);
  assert.deepEqual(themeSymbols([BTC_PERP, WBTC, ETH_PERP]), ['BTC', 'ETH']);
  const many = ['BTC', 'ETH', 'SOL', 'DOGE'].map((b) => market('perpl', `${b}-PERP`, b));
  assert.equal(themeSymbols(many).length, 3);
});

test('recents: newest first, no duplicates, capped', () => {
  const eth: Recent = { kind: 'market', venue: 'perpl', symbol: 'ETH-PERP', label: 'ETH-PERP' };
  const tengen: Recent = { kind: 'agent', id: 'a1', own: false, label: 'Tengen' };
  const xaut: Recent = { kind: 'market', venue: 'kuru', symbol: 'XAUT-USDC', label: 'XAUT' };
  let list = pushRecent([], eth);
  list = pushRecent(list, tengen);
  list = pushRecent(list, xaut);
  list = pushRecent(list, eth);
  assert.deepEqual(
    list.map((r) => r.label),
    ['ETH-PERP', 'XAUT', 'Tengen'],
  );
  assert.equal(pushRecent(list, { ...tengen, id: 'a2' }, 2).length, 2);
});

test('stored recents survive a round trip and drop anything malformed', () => {
  const list: Recent[] = [
    { kind: 'market', venue: 'kuru', symbol: 'MON-USDC', label: 'MON' },
    { kind: 'agent', id: 'a1', own: true, label: 'Range Hunter' },
  ];
  assert.deepEqual(parseRecents(JSON.stringify(list)), list);
  assert.deepEqual(parseRecents(null), []);
  assert.deepEqual(parseRecents('not json'), []);
  assert.deepEqual(
    parseRecents(
      JSON.stringify([{ kind: 'market', venue: 'binance', symbol: 'X', label: 'X' }, 3]),
    ),
    [],
  );
});

test('favourites toggle by market key and ignore junk', () => {
  const on = toggleFavourite(new Set(), 'kuru:MON-USDC');
  assert.deepEqual([...on], ['kuru:MON-USDC']);
  assert.deepEqual([...toggleFavourite(on, 'kuru:MON-USDC')], []);
  assert.deepEqual(
    [...parseFavourites(JSON.stringify(['perpl:ETH-PERP', 'nope', 42]))],
    ['perpl:ETH-PERP'],
  );
  assert.deepEqual([...parseFavourites('{')], []);
});

test('board mandate lines give up their markets and keep the prose out', () => {
  assert.deepEqual(boardMarkets('Kuru MON-USDC, WBTC-USDC +2 · Perpl BTC · max 50 per order'), [
    'MON-USDC',
    'WBTC-USDC',
    'BTC',
  ]);
  assert.deepEqual(boardMarkets('Kuru no markets · max 10 per order'), []);
});

function agent(id: string, name: string, kuru: string[], perpl: string[] = []): Agent {
  return {
    id,
    name,
    status: 'active',
    mandate: { kuru: { markets: kuru }, perpl: { markets: perpl } },
  } as unknown as Agent;
}

function row(
  agentId: string,
  name: string,
  wins: number,
  n: number,
  mandate: string,
): LeaderboardRow {
  return {
    rank: 1,
    agentId,
    name,
    model: 'm',
    mandate,
    address: '0x0000000000000000000000000000000000000000',
    venues: ['kuru', 'perpl'],
    indexed: true,
    n,
    wins,
    losses: n - wins,
    fills: n,
    winRate: n > 0 ? wins / n : null,
    realisedPnlUsd: '0',
    capitalDeployedUsd: '0',
    roi: 0.241,
    theses: { settled: 0, held: 0, open: 0 },
  };
}

function boardOf(rows: LeaderboardRow[]): Leaderboard {
  return {
    ranked: rows,
    tooFewTrades: [],
    formula: '',
    notes: [],
    minTrades: 5,
    source: { kind: 'ok' },
    generatedAt: '',
  };
}

const MON_BOOK = '0x26cd68436B6A4AEB3ec52abC20A4d121f8B4BAc9';

test('your agents trade symbols, not OrderBook addresses', () => {
  const [mine] = searchAgents([agent('a1', 'Range Hunter', [MON_BOOK])], new Map(), null);
  assert.deepEqual(mine!.markets, ['MON-USDC']);
  assert.equal(mine!.own, true);
  assert.equal(mine!.caption, 'Yours');
});

test('an agent on the board carries its sample; yours once, not twice', () => {
  const summaries = new Map<string, AgentSummary>([['a1', { trades: 9 } as AgentSummary]]);
  const agents = searchAgents(
    [agent('a1', 'Range Hunter', [MON_BOOK])],
    summaries,
    boardOf([
      row('a1', 'Range Hunter', 6, 9, 'Kuru MON-USDC · max 50 per order'),
      row('a2', 'Tengen', 7, 10, 'Kuru WETH-USDC · Perpl BTC · max 250 per order'),
    ]),
  );
  assert.deepEqual(
    agents.map((a) => [a.name, a.caption, a.own]),
    [
      ['Range Hunter', 'Yours · won 6 of 9', true],
      ['Tengen', 'Won 7 of 10 · Kuru · Perpl', false],
    ],
  );
  assert.deepEqual(agents[1]!.roi, { label: '+24.1%', up: true });
  assert.deepEqual(agents[1]!.markets, ['WETH-USDC', 'BTC']);
});

test('without the board, your agent falls back to its own trade count', () => {
  const summaries = new Map<string, AgentSummary>([['a1', { trades: 1 } as AgentSummary]]);
  const [mine] = searchAgents([agent('a1', 'Range Hunter', [MON_BOOK])], summaries, null);
  assert.equal(mine!.caption, 'Yours · 1 trade');
});

test('a trade count the server only partly holds says since when (SEN-159)', () => {
  const partial = { trades: 12, countsPartial: { since: Date.parse('2026-09-03T00:00:00Z') } };
  const summaries = new Map<string, AgentSummary>([['a1', partial as AgentSummary]]);
  const [mine] = searchAgents([agent('a1', 'Range Hunter', [MON_BOOK])], summaries, null);
  assert.equal(mine!.caption, 'Yours · 12 trades since Sep 3');
});

test('"mon" finds your MON agent through the market it trades', () => {
  const agents = searchAgents([agent('a1', 'Range Hunter', [MON_BOOK])], new Map(), null);
  const results = search('mon', [MON, MON_PERP, BTC_PERP], agents);
  assert.deepEqual(
    results.agents.map((a) => a.name),
    ['Range Hunter'],
  );
  assert.equal(agentsHeading(results.markets), 'Agents trading MON');
  assert.equal(agentsHeading([]), 'Agents');
});

test('highlight marks the first match, case-insensitively', () => {
  assert.deepEqual(highlight('gmonad maxi', 'MON'), [
    { text: 'g', hit: false },
    { text: 'mon', hit: true },
    { text: 'ad maxi', hit: false },
  ]);
  assert.deepEqual(highlight('MON', 'mon'), [{ text: 'MON', hit: true }]);
  assert.deepEqual(highlight('BTC', 'eth'), [{ text: 'BTC', hit: false }]);
  assert.deepEqual(highlight('BTC', '  '), [{ text: 'BTC', hit: false }]);
});
