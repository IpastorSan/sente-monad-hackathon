/** What Home shows about the agents (SEN-57). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { MarketDto, TickerDto } from '../markets/api.ts';
import { indexTickers, marketKey } from '../markets/select.ts';
import { agentBook } from '../portfolio/agentBook.ts';
import { allocation, allocationParts, holdings } from '../portfolio/view.ts';
import type { Portfolio } from '../trade/types.ts';

import type {
  ActivityEvent,
  Agent,
  AgentMandate,
  AgentPortfolioDto,
  AgentSummary,
  PositionDto,
} from './api.ts';
import {
  agentMarkets,
  atWork,
  biggestMoves,
  greeting,
  homeAgents,
  idleCash,
  latestMove,
  realisedSeries,
  realisedToday,
  sinceLabel,
  tickerItems,
  ownHoldings,
  totalValue,
  tradingTotal,
  walletCapital,
  watchlist,
} from './home.ts';
import { KURU_MARKETS } from './mandate.ts';

const NOW = Date.parse('2026-09-26T12:00:00.000Z');

function agent(id: string, status: Agent['status'] = 'active'): Agent {
  return { id, name: id, status } as Agent;
}

function summary(agentId: string, extra: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId,
    trades: 0,
    held: 0,
    theses: 0,
    pnl: { last24h: '0', allTime: '0' },
    largestOrderNotional: null,
    mandateSince: 0,
    lastEvent: null,
    ...extra,
  };
}

function lastAt(at: number): Pick<AgentSummary, 'lastEvent'> {
  return { lastEvent: { seq: 1, agentId: 'a', at, kind: 'fill', detail: {} } };
}

function activity(
  kind: string,
  detail: Record<string, unknown>,
  extra: Partial<ActivityEvent> = {},
): ActivityEvent {
  return { seq: 7, agentId: 'a1', agentName: 'Range Hunter', at: NOW, kind, detail, ...extra };
}

test('homeAgents puts active before revoked, busiest first, and keeps the limit', () => {
  const summaries = new Map([
    ['old', summary('old', lastAt(NOW - 60_000))],
    ['busy', summary('busy', lastAt(NOW))],
  ]);
  const agents = [agent('gone', 'revoked'), agent('quiet'), agent('old'), agent('busy')];
  assert.deepEqual(
    homeAgents(agents, summaries, 3).map((a) => a.id),
    ['busy', 'old', 'quiet'],
  );
  // The default fills Home's two-by-two grid, revoked last.
  assert.deepEqual(
    homeAgents([...agents, agent('extra')], summaries).map((a) => a.id),
    ['busy', 'old', 'quiet', 'extra'],
  );
});

test('a fill reads as a sentence with its block for the ramp', () => {
  const consensus = { state: 'Voted', at: { proposed: NOW } };
  const move = latestMove(
    activity(
      'fill',
      {
        venue: 'kuru',
        symbol: 'MON-USDC',
        side: 'buy',
        filledSize: '180',
        averageFillPrice: '0.9744',
        blockNumber: 42,
      },
      { consensus },
    ),
  );
  assert.deepEqual(move, {
    agentId: 'a1',
    at: NOW,
    stone: 'trade',
    title: 'Range Hunter bought 180 MON',
    detail: 'at 0.9744 on Kuru',
    block: { number: 42, consensus },
  });
});

test('a refusal is the enclave holding, with no ramp', () => {
  const move = latestMove(
    activity(
      'refusal',
      { code: 'policy_violation', message: 'Over the cap.' },
      { layer: 'enclave' },
    ),
  );
  assert.equal(move?.stone, 'refusal');
  assert.equal(move?.title, 'The enclave held Range Hunter to its mandate');
  assert.equal(move?.detail, 'Over the cap.');
  assert.equal(move?.block, null);
});

test('a verdict takes the stone of its outcome', () => {
  assert.equal(latestMove(activity('close', { realizedPnl: '-3', symbol: 'BTC' }))?.stone, 'loss');
  assert.equal(latestMove(activity('verdict', { pnl: '12.4', held: true }))?.stone, 'win');
});

test('an event the Ledger does not show is not a move', () => {
  assert.equal(latestMove(activity('run', {})), null);
  assert.equal(latestMove(activity('order', { status: 'filled' })), null);
});

test('sinceLabel is coarse', () => {
  assert.equal(sinceLabel(NOW - 5_000, NOW), 'now');
  assert.equal(sinceLabel(NOW - 4 * 60_000, NOW), '4m ago');
  assert.equal(sinceLabel(NOW - 3 * 3_600_000, NOW), '3h ago');
  assert.equal(sinceLabel(NOW - 49 * 3_600_000, NOW), '2d ago');
  assert.equal(sinceLabel(NOW + 5_000, NOW), 'now');
});

// ---------------------------------------------------------------------------
// Trading-first Home (SEN-113)

const H = 3_600_000;

function cashOf(ausd: string, usdc: string) {
  return [
    { symbol: 'AUSD', amount: ausd },
    { symbol: 'USDC', amount: usdc },
    { symbol: 'MON', amount: '0.42' },
  ];
}

/** An agent's capital as the portfolio route reports it: `amount` USDC. */
function capital(amount: string) {
  return {
    source: 'portfolio' as const,
    usd: amount,
    amounts: [{ asset: 'USDC', amount: amount }],
  };
}

test('totalValue adds wallet stables and agent capital exactly, per asset, never MON', () => {
  const total = totalValue(cashOf('1284.5', '500'), [capital('612.4'), capital('300')]);
  assert.deepEqual(total?.amounts, [
    { asset: 'USDC', amount: '1412.4' },
    { asset: 'AUSD', amount: '1284.5' },
  ]);
  assert.equal(
    total?.includes,
    'Your USDC and AUSD plus your agents’. Not yet your own positions.',
  );
});

test('totalValue waits for the wallet and names what it leaves out', () => {
  assert.equal(totalValue(null, [capital('1')]), null);
  const partial = totalValue(cashOf('1', '2'), [
    { source: 'wallet', usd: '0.1', amounts: [{ asset: 'USDC', amount: '0.1' }] },
    { source: 'unread' },
    { source: 'unread' },
  ]);
  assert.deepEqual(partial?.amounts, [
    { asset: 'USDC', amount: '2.1' },
    { asset: 'AUSD', amount: '1' },
  ]);
  assert.equal(
    partial?.includes,
    'Your USDC and AUSD plus your agents’. Not yet your own positions or your agents’ open trades. 2 agents couldn’t be read and are left out.',
  );
  assert.equal(
    totalValue(cashOf('0', '0'), [])?.includes,
    'Your USDC and AUSD. Not yet your own positions.',
  );
});

// ---------------------------------------------------------------------------
// The total with trading on (SEN-155)

function kuruTicker(symbol: string, last: string): TickerDto {
  return { venue: 'kuru', symbol, last, mid: null } as TickerDto;
}

const PRICES = [kuruTicker('MON-USDC', '0.9812')];

const ETH_PERP: PositionDto = {
  symbol: 'ETH-PERP',
  side: 'long',
  size: '0.25',
  entryPrice: '2498.00',
  markPrice: '2544.10',
  liquidationPriceEst: '1690.00',
  leverage: 3,
  margin: '208.17',
  unrealizedPnl: '11.53',
  realizedPnl: null,
  fundingPaid: '0.38',
  quote: 'AUSD',
  updatedAt: NOW,
};

function userPortfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    asOf: NOW,
    wallet: {
      ok: true,
      balances: [
        { symbol: 'MON', address: '0x0', decimals: 18, raw: '0', amount: '412.42' },
        { symbol: 'USDC', address: '0x1', decimals: 6, raw: '0', amount: '500' },
        { symbol: 'AUSD', address: '0x2', decimals: 6, raw: '0', amount: '1284.5' },
      ],
    },
    kuru: {
      ok: true,
      accountId: '7',
      balances: [{ asset: 'USDC', available: '0', locked: '142.5', total: '142.5' }],
      openOrders: [],
    },
    perpl: {
      ok: true,
      status: 'ok',
      accountId: '9',
      balances: [{ asset: 'AUSD', available: '100', locked: '0', total: '308.17' }],
      positions: [ETH_PERP],
      openOrders: [],
    },
    ...overrides,
  };
}

/** What `useUserPortfolio` hands both screens as the wallet. */
function walletOf(p: Portfolio) {
  return p.wallet.ok ? p.wallet.balances.map(({ symbol, amount }) => ({ symbol, amount })) : [];
}

function read(data: Portfolio | null, error: Error | null = null) {
  return { data, error, unavailable: false };
}

function agentPortfolio(usdc: string): AgentPortfolioDto {
  return {
    totals: { approxUsd: usdc },
    wallet: {
      ok: true,
      balances: [{ asset: 'USDC', available: usdc, locked: '0', total: usdc, decimals: 6 }],
    },
    kuru: { ok: false, error: 'n/a' },
    perpl: { ok: false, error: 'n/a' },
    holdings: [],
  } as unknown as AgentPortfolioDto;
}

test('Home’s total is the Portfolio tab’s total for the same data (SEN-155)', () => {
  const p = userPortfolio();
  // The Portfolio tab's hero, as `portfolio.tsx` computes it.
  const held = holdings(walletOf(p), p, PRICES);
  const group = agentBook(
    [
      {
        agent: { ...agent('a'), mandate: { expiresAt: 4e9 } },
        portfolio: agentPortfolio('612.4'),
        entries: [],
      },
      {
        agent: { ...agent('b'), mandate: { expiresAt: 4e9 } },
        portfolio: agentPortfolio('300'),
        entries: [],
      },
    ],
    PRICES,
    0,
  );
  const portfolioTotal = allocation(allocationParts(held, group.total)).amounts;

  const home = tradingTotal(ownHoldings(read(p), walletOf(p), PRICES), [
    capital('612.4'),
    capital('300'),
  ]);
  assert.deepEqual(home?.amounts, portfolioTotal);
  // USDC: wallet 500 + Kuru 142.5 + agents 912.4. AUSD: wallet 1284.5 + Perpl
  // free 100.00 + perp 219.70. MON as itself, never at its price.
  assert.deepEqual(home?.amounts, [
    { asset: 'USDC', amount: '1554.9' },
    { asset: 'AUSD', amount: '1604.20' },
    { asset: 'MON', amount: '412.42' },
  ]);
  assert.equal(
    home?.includes,
    'Your cash, spot tokens and perps (margin + P&L), plus your agents’.',
  );
});

test('the trading total waits for /portfolio and the tickers instead of jumping', () => {
  const p = userPortfolio();
  assert.equal(ownHoldings(read(null), walletOf(p), PRICES), null, '/portfolio still out');
  assert.equal(ownHoldings(read(p), walletOf(p), null), null, 'tickers still out');
  assert.equal(ownHoldings(read(p), null, PRICES), null, 'wallet still out');
  assert.equal(tradingTotal(null, []), null);
});

test('a /portfolio that failed leaves both venues out and says so, never as zero', () => {
  const wallet = walletOf(userPortfolio());
  const total = tradingTotal(ownHoldings(read(null, new Error('503')), wallet, PRICES), []);
  // Wallet cash and MON only: nothing from Kuru or Perpl.
  assert.deepEqual(total?.amounts, [
    { asset: 'USDC', amount: '500' },
    { asset: 'AUSD', amount: '1284.5' },
    { asset: 'MON', amount: '412.42' },
  ]);
  assert.equal(
    total?.includes,
    'Your cash, spot tokens and perps (margin + P&L). Leaves out Kuru and Perpl: they didn’t answer.',
  );
  const refused = ownHoldings({ data: null, error: null, unavailable: true }, wallet, PRICES);
  assert.equal(refused?.venues, 'unread');
});

test('a failed section, unlinked perps and unread agents are all named', () => {
  const p = userPortfolio({
    perpl: { ok: false, error: 'socket refused' },
  });
  const perplDown = tradingTotal(ownHoldings(read(p), walletOf(p), []), [
    { source: 'wallet', usd: '5', amounts: [{ asset: 'USDC', amount: '5' }] },
    { source: 'unread' },
  ]);
  // No tickers: MON has no price, and needs none, since it is listed as itself.
  assert.deepEqual(perplDown?.amounts, [
    { asset: 'USDC', amount: '647.5' },
    { asset: 'AUSD', amount: '1284.5' },
    { asset: 'MON', amount: '412.42' },
  ]);
  assert.equal(
    perplDown?.includes,
    'Your cash, spot tokens and perps (margin + P&L), plus your agents’. Not yet your agents’ open trades. Leaves out Perpl: it didn’t answer. One agent couldn’t be read and is left out.',
  );

  const unlinked = userPortfolio({
    wallet: { ok: false, error: 'rpc' },
    perpl: {
      ok: true,
      status: 'unlinked',
      accountId: '9',
      balances: [{ asset: 'AUSD', available: '50', locked: '0', total: '50' }],
    },
  });
  const noPerps = tradingTotal(ownHoldings(read(unlinked), cashOf('10', '0'), PRICES), []);
  assert.deepEqual(noPerps?.amounts, [
    { asset: 'USDC', amount: '142.5' },
    { asset: 'AUSD', amount: '60' },
    { asset: 'MON', amount: '0.42' },
  ]);
  assert.equal(
    noPerps?.includes,
    'Your cash, spot tokens and perps (margin + P&L). Some wallet tokens may be left out. Perp positions are left out until Perpl is linked.',
  );
});

test('walletCapital keeps each stable apart, ungrouped and at full precision', () => {
  const tokens = [
    { symbol: 'USDC', decimals: 6 },
    { symbol: 'AUSD', decimals: 6 },
  ];
  assert.deepEqual(walletCapital({ USDC: 1_204_500_000n, AUSD: 1n }, tokens), {
    source: 'wallet',
    usd: '1204.500001',
    amounts: [
      { asset: 'USDC', amount: '1204.500000' },
      { asset: 'AUSD', amount: '0.000001' },
    ],
  });
  const empty = walletCapital({}, tokens);
  assert.equal(empty.source === 'wallet' && empty.usd, '0.000000');
});

test('realisedToday sums the day per asset, never USDC and AUSD as one', () => {
  const agents = [
    { id: 'a', mandate: mandate(['kuru']) },
    { id: 'b', mandate: mandate(['perpl']) },
  ];
  const summaries = new Map([
    ['a', summary('a', { pnl: { last24h: '18.22', allTime: '0' } })],
    ['b', summary('b', { pnl: { last24h: '-4.10', allTime: '0' } })],
  ]);
  assert.deepEqual(realisedToday(agents, summaries), {
    value: '14.12',
    label: '+18.22 USDC · −4.10 AUSD realised by agents today',
    tone: null,
  });
  assert.deepEqual(
    realisedToday(
      agents,
      new Map([['b', summary('b', { pnl: { last24h: '-4.1', allTime: '0' } })]]),
    ),
    { value: '-4.1', label: '−4.10 AUSD realised by agents today', tone: 'down' },
  );
  assert.deepEqual(realisedToday(agents, new Map([['a', summary('a')]])), {
    value: '0',
    label: 'Agents flat today',
    tone: null,
  });
  assert.equal(realisedToday(agents, new Map()), null);
  // A Kuru and Perpl agent on an API that only sends the mixed sum: no line.
  const both = [{ id: 'c', mandate: mandate(['kuru', 'perpl']) }];
  assert.equal(realisedToday(both, new Map([['c', summary('c')]])), null);
  const split = summary('c', {
    pnl: {
      last24h: '0.83',
      allTime: '0',
      byAsset: [
        { asset: 'AUSD', last24h: '0.96', allTime: '0' },
        { asset: 'USDC', last24h: '-0.13', allTime: '0' },
      ],
    },
  });
  assert.equal(
    realisedToday(both, new Map([['c', split]]))?.label,
    '−0.13 USDC · +0.96 AUSD realised by agents today',
  );
});

function verdict(agentId: string, seq: number, at: number, pnl: string): ActivityEvent {
  return {
    seq,
    agentId,
    agentName: agentId,
    at,
    kind: 'verdict',
    detail: { market: 'MON-USDC', direction: 'long', realisedPnl: pnl },
  };
}

test('realisedSeries steps through the day and lands on the summary figure', () => {
  const events = [
    verdict('b', 3, NOW - H, '-4'), // newest first, as the route sends them
    verdict('a', 9, NOW - 2 * H, '10'),
    verdict('a', 8, NOW - 30 * H, '99'), // outside the window
  ];
  assert.deepEqual(realisedSeries(events, '6', NOW), ['0', '10', '6']);
  // A page that does not reach the window's start: the start carries the rest.
  assert.deepEqual(realisedSeries(events, '20', NOW), ['14', '24', '20']);
  // No summary: the page's own sum is the end.
  assert.deepEqual(realisedSeries(events, null, NOW), ['0', '10', '6']);
});

test('realisedSeries has no line without a settled trade', () => {
  assert.equal(realisedSeries([], '0', NOW), null);
  assert.equal(realisedSeries([verdict('a', 1, NOW - 30 * H, '5')], '0', NOW), null);
  const close: ActivityEvent = { ...verdict('a', 2, NOW - H, '5'), kind: 'close' };
  assert.equal(realisedSeries([close], '5', NOW), null);
});

test('greeting follows the hour', () => {
  assert.equal(greeting(7), 'Good morning');
  assert.equal(greeting(13), 'Good afternoon');
  assert.equal(greeting(21), 'Good evening');
  assert.equal(greeting(2), 'Good evening');
});

function mandate(venues: AgentMandate['venues'], kuru: string[] = [], perpl: string[] = []) {
  return {
    venues,
    kuru: { markets: kuru, maxDepositAtoms: {} },
    perpl: { maxCollateralAtoms: 0n, maxLeverage: 1, markets: perpl },
  } as unknown as AgentMandate;
}

test('atWork names the quote currency, and gives each asset its own figure on both venues', () => {
  const day = (last24h: string, byAsset?: AgentSummary['pnl']['byAsset']) =>
    summary('a', { pnl: { last24h, allTime: '0', byAsset }, ...lastAt(NOW) });
  assert.deepEqual(atWork({ mandate: mandate(['kuru']) }, day('18.22')).pnl, {
    label: '+18.22 USDC',
    tone: 'up',
  });
  assert.equal(atWork({ mandate: mandate(['perpl']) }, day('-4.1')).pnl?.label, '−4.10 AUSD');
  assert.equal(atWork({ mandate: mandate(['kuru']) }, day('0')).pnl?.label, '0.00 USDC');
  // Both venues: per asset when the API splits it, no figure when it cannot.
  assert.equal(atWork({ mandate: mandate(['kuru', 'perpl']) }, day('3.1')).pnl, null);
  assert.deepEqual(
    atWork(
      { mandate: mandate(['kuru', 'perpl']) },
      day('0.83', [
        { asset: 'AUSD', last24h: '0.96', allTime: '0' },
        { asset: 'USDC', last24h: '-0.13', allTime: '0' },
      ]),
    ).pnl,
    { label: '−0.13 USDC\n+0.96 AUSD', tone: null },
  );
  assert.equal(
    atWork({ mandate: mandate(['kuru', 'perpl']) }, day('0', [])).pnl?.label,
    '0.00 USDC',
  );
  assert.equal(
    atWork(
      { mandate: mandate(['perpl', 'kuru']) },
      day('0', [{ asset: 'AUSD', last24h: '0', allTime: '1' }]),
    ).pnl?.label,
    '0.00 AUSD',
  );
  assert.deepEqual(atWork({ mandate: mandate(['kuru']) }, undefined), { move: null, pnl: null });
});

function market(
  venue: MarketDto['venue'],
  symbol: string,
  base: string,
  extra: Partial<MarketDto> = {},
): MarketDto {
  return {
    venue,
    symbol,
    venueSymbol: symbol,
    kind: venue === 'kuru' ? 'spot' : 'perp',
    base,
    quote: venue === 'kuru' ? 'USDC' : 'AUSD',
    tickSize: '0.0001',
    stepSize: '0.1',
    minSize: '0.1',
    minNotional: null,
    maxLeverage: venue === 'perpl' ? 10 : null,
    marginMode: venue === 'perpl' ? 'isolated' : null,
    makerFee: '0',
    takerFee: '0',
    ...extra,
  };
}

function ticker(
  m: MarketDto,
  last: string | null,
  change: string | null,
  volume: string | null = null,
): TickerDto {
  return {
    venue: m.venue,
    symbol: m.symbol,
    quote: m.quote,
    last,
    mark: null,
    index: null,
    bid: null,
    ask: null,
    mid: null,
    open24h: null,
    high24h: null,
    low24h: null,
    change24h: null,
    change24hPct: change,
    quoteVolume24h: volume,
    funding: null,
    stale: false,
    asOf: 0,
  };
}

const MON = market('kuru', 'MON-USDC', 'MON');
const MON_PERP = market('perpl', 'MON-PERP', 'MON', { venueSymbol: 'MON' });
const BTC_PERP = market('perpl', 'BTC-PERP', 'BTC', { venueSymbol: 'BTC' });
const XAUT = market('kuru', 'XAUT-USDC', 'XAUT');
const MARKETS = [MON, MON_PERP, BTC_PERP, XAUT];
const TICKERS = indexTickers([
  ticker(MON, '0.9812', '0.0241', '100'),
  ticker(MON_PERP, '0.9809', '-0.0305', '900'),
  ticker(BTC_PERP, '64188.5', '0.0058', null),
  ticker(XAUT, null, null, '50'),
]);

test('tickerItems runs busiest first, labels spot by base, and skips unpriced markets', () => {
  assert.deepEqual(
    tickerItems(MARKETS, TICKERS).map((item) => [item.symbol, item.price]),
    [
      ['MON-PERP', '0.9809'],
      ['MON', '0.9812'],
      ['BTC-PERP', '64188.5'],
    ],
  );
  const [first] = tickerItems(MARKETS, TICKERS);
  assert.ok(Math.abs((first?.changePct ?? 0) - -3.05) < 1e-9);
});

test('watchlist keeps the list order of starred markets', () => {
  const starred = new Set([marketKey(XAUT), marketKey(MON)]);
  assert.deepEqual(watchlist(MARKETS, starred), [MON, XAUT]);
  assert.deepEqual(watchlist(MARKETS, new Set()), []);
});

test('biggestMoves sorts by the size of the move, either way, and drops unknowns', () => {
  assert.deepEqual(biggestMoves(MARKETS, TICKERS), [MON_PERP, MON, BTC_PERP]);
  assert.deepEqual(biggestMoves(MARKETS, TICKERS, 1), [MON_PERP]);
});

test('agentMarkets counts active agents per market, most shared first', () => {
  const monBook = KURU_MARKETS.find((m) => m.symbol === 'MON-USDC')!.address;
  const agents = [
    { status: 'active' as const, mandate: mandate(['kuru'], [monBook]) },
    { status: 'active' as const, mandate: mandate(['kuru', 'perpl'], [monBook], ['btc']) },
    { status: 'active' as const, mandate: mandate(['perpl'], [], ['MON']) },
    { status: 'revoked' as const, mandate: mandate(['perpl'], [], ['BTC']) },
  ];
  assert.deepEqual(
    agentMarkets(agents, MARKETS).map((row) => [row.market.symbol, row.caption]),
    [
      ['MON-USDC', '2 agents'],
      ['MON-PERP', '1 agent'],
      ['BTC-PERP', '1 agent'],
    ],
  );
  assert.deepEqual(agentMarkets([], MARKETS), []);
});

test('idleCash names what sits in the wallet, or nothing', () => {
  const balance = (symbol: string, raw: bigint) => ({ symbol, raw, decimals: 6 });
  assert.equal(
    idleCash([balance('AUSD', 1_284_500_000n), balance('USDC', 500_000_000n)]),
    '1,284.50 AUSD and 500.00 USDC are sitting idle.',
  );
  assert.equal(
    idleCash([balance('AUSD', 0n), balance('USDC', 5_000_000n)]),
    '5.00 USDC is sitting idle.',
  );
  assert.equal(idleCash([balance('AUSD', 0n), balance('MON', 9n)]), null);
  assert.equal(idleCash(null), null);
});
