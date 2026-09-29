/**
 * What the asset page prints (SEN-112): header, ranges, the scrub-bound
 * headline, the change grid, stats, funding, book pressure and the agents
 * trading the market. Plain node, no device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Agent, AgentFill, AgentPortfolioDto } from '../agents/api.ts';
import { KURU_MARKETS } from '../agents/mandate.ts';
import type { PortfolioFill } from '../trade/types.ts';

import type { DepthDto, KlineDto, MarketDto, TickerDto } from './api.ts';
import {
  agentsFills,
  agentsFor,
  agentStake,
  assetHeader,
  bookSums,
  changeGrid,
  compactAmount,
  countdown,
  defaultView,
  feeLabel,
  fillLine,
  fillMarkers,
  fillWhen,
  fundingView,
  headline,
  mergeFills,
  yourFills,
  linePoints,
  parseVenue,
  placesFor,
  rangesFor,
  scrubTime,
  signedAmount,
  spreadLabel,
  statRows,
} from './asset.ts';

const MON_BOOK = KURU_MARKETS.find((m) => m.symbol === 'MON-USDC')!.address;

const MON: MarketDto = {
  venue: 'kuru',
  symbol: 'MON-USDC',
  venueSymbol: 'MONUSDC',
  kind: 'spot',
  base: 'MON',
  quote: 'USDC',
  tickSize: '0.0001',
  stepSize: '0.01',
  minSize: '0.01',
  minNotional: '1',
  maxLeverage: null,
  marginMode: null,
  makerFee: '0',
  takerFee: '0.0007',
};

const ETH: MarketDto = {
  ...MON,
  venue: 'perpl',
  symbol: 'ETH-PERP',
  venueSymbol: 'ETH',
  kind: 'perp',
  base: 'ETH',
  quote: 'AUSD',
  tickSize: '0.1',
  minNotional: null,
  maxLeverage: 20,
  marginMode: 'isolated',
};

function ticker(over: Partial<TickerDto> = {}): TickerDto {
  return {
    venue: 'kuru',
    symbol: 'MON-USDC',
    quote: 'USDC',
    last: '0.9812',
    mark: null,
    index: null,
    bid: '0.981',
    ask: '0.9814',
    mid: '0.9812',
    open24h: null,
    high24h: '0.9932',
    low24h: '0.9541',
    change24h: null,
    change24hPct: '0.0241',
    quoteVolume24h: '184210.37',
    funding: null,
    stale: false,
    asOf: 0,
    ...over,
  };
}

const MIN = 60_000;

/** `n` 5-minute candles ending at `end`, open rising by 0.01 each. */
function candles(n: number, end = 1_000 * 5 * MIN, step = 5 * MIN): KlineDto[] {
  return Array.from({ length: n }, (_, i) => {
    const openTime = end - (n - i) * step;
    const open = (1 + i * 0.01).toFixed(2);
    return {
      openTime,
      closeTime: openTime + step - 1,
      open,
      high: open,
      low: open,
      close: (1 + (i + 1) * 0.01).toFixed(2),
      volume: '1',
      quoteVolume: null,
    };
  });
}

test('the header names the quote and the venue, and the actions follow the kind', () => {
  assert.deepEqual(assetHeader(MON), {
    title: 'MON',
    caption: 'MON-USDC · Kuru spot',
    unit: 'USDC',
    perp: false,
    actions: ['Sell', 'Buy'],
  });
  const eth = assetHeader(ETH);
  assert.equal(eth.caption, 'ETH-AUSD · Perpl perps');
  assert.equal(eth.unit, 'AUSD');
  assert.deepEqual(eth.actions, ['Short', 'Long']);
});

test('only listed venues parse from the route', () => {
  assert.equal(parseVenue('kuru'), 'kuru');
  assert.equal(parseVenue(['perpl']), 'perpl');
  assert.equal(parseVenue('binance'), null);
  assert.equal(parseVenue(undefined), null);
});

test('decimals come from the tick', () => {
  assert.equal(placesFor(MON, null), 4);
  assert.equal(placesFor(ETH, null), 1);
  assert.equal(placesFor({ ...ETH, tickSize: '1' }, null), 0);
  assert.equal(placesFor({ ...ETH, tickSize: '0.50' }, null), 1);
});

test('perps skip 1Y and open on candles; spot opens on a week of line', () => {
  assert.deepEqual(rangesFor(MON), ['1H', '1D', '1W', '1M', '1Y']);
  assert.deepEqual(rangesFor(ETH), ['1H', '1D', '1W', '1M']);
  assert.deepEqual(defaultView(MON), { range: '1W', kind: 'line' });
  assert.deepEqual(defaultView(ETH), { range: '1D', kind: 'candles' });
});

test('the line ends on the live price', () => {
  assert.deepEqual(linePoints(candles(3), '9.99'), ['1.01', '1.02', '9.99']);
  assert.deepEqual(linePoints(candles(2), null), ['1.01', '1.02']);
  assert.deepEqual(linePoints([], '1'), []);
});

test('the headline is the live price over the window, or the scrubbed candle', () => {
  const k = candles(3); // opens 1.00, 1.01, 1.02; closes 1.01, 1.02, 1.03
  const live = headline(k, '1.10', '1W', null);
  assert.equal(live.price, '1.10');
  assert.ok(Math.abs(live.pct! - 10) < 1e-9);
  assert.equal(live.suffix, ' past week');
  assert.equal(live.at, null);

  const scrubbed = headline(k, '1.10', '1W', 1);
  assert.equal(scrubbed.price, '1.02');
  assert.ok(Math.abs(scrubbed.pct! - 2) < 1e-9);
  assert.equal(scrubbed.suffix, scrubTime(k[1]!.openTime, '1W'));
  assert.equal(scrubbed.at, k[1]!.openTime);

  assert.deepEqual(headline([], null, '1D', null), {
    price: null,
    pct: null,
    suffix: ' today',
    at: null,
  });
});

test('the scrub names the candle in local time, as coarse as the range', () => {
  const ms = new Date(2026, 8, 23, 14, 5).getTime();
  assert.equal(scrubTime(ms, '1H'), ' at 14:05');
  assert.equal(scrubTime(ms, '1W'), ' at Sep 23, 14:05');
  assert.equal(scrubTime(ms, '1Y'), ' on Sep 23');
});

test('the change grid measures each horizon and dashes one the candles do not reach', () => {
  const k = candles(24); // two hours of 5m candles
  const cells = changeGrid(k, '2', null);
  assert.deepEqual(
    cells.map((c) => c.label),
    ['5M', '1H', '4H', '1D'],
  );
  // 5M: the last candle's open (1.23); 1H: the 12th from the end (1.12).
  assert.ok(Math.abs(cells[0]!.pct! - (2 / 1.23 - 1) * 100) < 1e-9);
  assert.ok(Math.abs(cells[1]!.pct! - (2 / 1.12 - 1) * 100) < 1e-9);
  assert.equal(cells[2]!.pct, null);
  assert.equal(cells[3]!.pct, null);
  assert.equal(cells[3]!.primary, true);
});

test('the grid’s 1D cell is the ticker’s 24h change, the number used everywhere else', () => {
  const cells = changeGrid(candles(24), '2', ticker({ change24hPct: '-0.0096' }));
  assert.ok(Math.abs(cells[3]!.pct! - -0.96) < 1e-9);
  assert.deepEqual(
    changeGrid([], null, null).map((c) => c.pct),
    [null, null, null, null],
  );
});

test('spot stats: range, quote volume, spread, a notional minimum and the fee', () => {
  assert.deepEqual(statRows(MON, ticker()), [
    { label: '24h range', value: '0.9541 – 0.9932' },
    { label: '24h volume', value: '184,210 USDC' },
    { label: 'Spread', value: '0.0004 (0.04%)' },
    { label: 'Min order', value: '1.00 USDC' },
    { label: 'Taker fee', value: '0.07%' },
  ]);
});

test('perp stats: leverage and margin instead of a minimum; missing figures are left out', () => {
  const rows = statRows(
    ETH,
    ticker({ high24h: null, bid: null, quoteVolume24h: '41234567', quote: 'AUSD' }),
  );
  assert.deepEqual(rows, [
    { label: '24h volume', value: '41.2M AUSD' },
    { label: 'Max leverage', value: '20×' },
    { label: 'Margin', value: 'Isolated' },
    { label: 'Taker fee', value: '0.07%' },
  ]);
});

test('small formatting rules', () => {
  assert.equal(spreadLabel('1', '0.9', '0.1'), null); // crossed
  assert.equal(spreadLabel(null, '1', '0.1'), null);
  assert.equal(feeLabel('0.00025'), '0.025%');
  assert.equal(compactAmount('1250000000'), '1.3B');
  assert.equal(compactAmount('999'), '999');
  assert.equal(signedAmount('1.224'), '+1.22');
  assert.equal(signedAmount('-0.4'), '−0.40');
  assert.equal(signedAmount('0.001'), '0.00');
});

test('a stake P&L in exponent form still reads as a figure (SEN-136)', () => {
  // Pre-fix: `null`, so the stake line lost its P&L.
  assert.equal(signedAmount('1e-7'), '0.00');
  assert.equal(signedAmount('-2.5e1'), '−25.00');
});

test('funding says who pays in words, then the rate and the countdown', () => {
  const now = 1_000_000;
  assert.deepEqual(
    fundingView({ rate: '0.0001', intervalHours: 8, nextAt: now + 192 * MIN }, now),
    { payer: 'longs pay shorts', rate: '+0.0100% / 8h', nextIn: '3h 12m' },
  );
  assert.equal(
    fundingView({ rate: '-0.0002', intervalHours: 1, nextAt: null }, now)!.payer,
    'shorts pay longs',
  );
  assert.equal(
    fundingView({ rate: '0', intervalHours: 8, nextAt: null }, now)!.rate,
    '0.0000% / 8h',
  );
  assert.equal(fundingView(null, now), null);
  // SEN-145: Perpl's 2,580 s interval, not `0.7166666666666667h`.
  assert.equal(
    fundingView({ rate: '0.00003', intervalHours: 2580 / 3600, nextAt: null }, now)!.rate,
    '+0.0030% / 43m',
  );
  assert.equal(
    fundingView({ rate: '0.00003', intervalHours: 1.5, nextAt: null }, now)!.rate,
    '+0.0030% / 1h 30m',
  );
  assert.equal(countdown(now + 30_000, now), 'under 1m');
  assert.equal(countdown(now + 12 * MIN, now), '12m');
});

test('book pressure sums the top ten levels a side', () => {
  const side = Array.from({ length: 12 }, () => ({ price: '1', size: '2' }));
  const depth: DepthDto = {
    venue: 'kuru',
    symbol: 'MON-USDC',
    bids: side,
    asks: side.slice(0, 3),
    sequence: null,
    stale: false,
    asOf: 0,
  };
  const sums = bookSums(depth);
  assert.equal(Number(sums.bids), 20);
  assert.equal(Number(sums.asks), 6);
});

function agent(id: string, kuru: string[], perpl: string[] = [], active = true): Agent {
  return {
    id,
    name: id,
    status: active ? 'active' : 'revoked',
    mandate: { kuru: { markets: kuru }, perpl: { markets: perpl } },
  } as unknown as Agent;
}

test('only active agents whose mandate names the market are asked for a portfolio', () => {
  const agents = [
    agent('mon', [MON_BOOK]),
    agent('eth-symbol', [], ['ETH-PERP']),
    agent('eth-base', [], ['eth']),
    agent('btc', [], ['BTC-PERP']),
    agent('revoked', [MON_BOOK], [], false),
  ];
  assert.deepEqual(
    agentsFor(agents, MON).map((a) => a.id),
    ['mon'],
  );
  assert.deepEqual(
    agentsFor(agents, ETH).map((a) => a.id),
    ['eth-symbol', 'eth-base'],
  );
});

function portfolio(over: Partial<AgentPortfolioDto>): AgentPortfolioDto {
  return {
    agentId: 'a',
    address: '0x',
    asOf: 0,
    wallet: { ok: false, error: 'x' },
    kuru: { ok: false, error: 'x' },
    perpl: { ok: true, status: 'not_in_mandate' },
    holdings: [],
    totals: { approxUsd: '0', byQuote: { USDC: '0', AUSD: '0' }, note: '' },
    ...over,
  };
}

test('an agent’s stake: a perp position, a spot holding, or honestly none', () => {
  const perp = portfolio({
    perpl: {
      ok: true,
      status: 'ok',
      accountId: '1',
      balances: [],
      openOrders: [],
      positions: [
        {
          symbol: 'ETH-PERP',
          side: 'long',
          size: '0.250',
          entryPrice: '2498',
          markPrice: '2544.1',
          liquidationPriceEst: '1690',
          leverage: 3,
          margin: '208.17',
          unrealizedPnl: '11.53',
          realizedPnl: null,
          fundingPaid: null,
          quote: 'AUSD',
          updatedAt: 0,
        },
      ],
    },
  });
  assert.deepEqual(agentStake(perp, ETH), {
    line: 'Long 0.25 ETH 3× from 2,498.0',
    pnl: '11.53',
  });

  const spot = portfolio({
    holdings: [
      {
        asset: 'MON',
        market: 'MON-USDC',
        amount: '180',
        inWallet: '0',
        inAccount: '180',
        lockedInOrders: '0',
        markPrice: '0.9812',
        value: '176.6',
        costBasis: {
          avgPrice: '0.9744',
          coveredSize: '180',
          uncoveredSize: '0',
          unrealizedPnl: '1.22',
          complete: true,
          source: 'event-log-fifo',
        },
      },
    ],
  });
  assert.deepEqual(agentStake(spot, MON), { line: 'Holds 180 MON at 0.9744', pnl: '1.22' });
  assert.deepEqual(agentStake(portfolio({}), MON), { line: 'No position right now', pnl: null });
  assert.deepEqual(agentStake(null, ETH), { line: 'Allowed to trade here', pnl: null });
});

// ─── Fills on the chart (SEN-157) ──────────────────────────────────────────

function mine(at: number, over: Partial<PortfolioFill> = {}): PortfolioFill {
  return {
    venue: 'kuru',
    tradeId: `t-${at}`,
    venueTradeId: `v-${at}`,
    orderId: null,
    symbol: 'MON-USDC',
    side: 'buy',
    price: '0.9459',
    size: '212',
    fee: null,
    feeAsset: null,
    transactionHash: null,
    timestamp: at,
    ...over,
  };
}

function theirs(seq: number, at: number, over: Partial<AgentFill> = {}): AgentFill {
  return {
    seq,
    agentId: 'a-1',
    agentName: 'Range Hunter',
    venue: 'kuru',
    symbol: 'MON-USDC',
    side: 'buy',
    price: '0.9744',
    size: '180.000',
    orderId: null,
    txHash: null,
    at,
    ...over,
  };
}

test('fills map onto the candle they happened in; outside the visible range they are dropped', () => {
  const k = candles(4);
  const fills = [
    ...yourFills(
      [mine(k[0]!.openTime - 1), mine(k[1]!.openTime), mine(k[3]!.closeTime)],
      'MON-USDC',
    ),
    ...agentsFills(
      [theirs(1, k[2]!.openTime + 90_000), theirs(2, k[3]!.closeTime + 1)],
      'MON-USDC',
    ),
  ];
  assert.deepEqual(fillMarkers(fills, k), [
    { index: 1, who: 'you' },
    { index: 3, who: 'you' },
    { index: 2, who: 'agent' },
  ]);
  assert.deepEqual(fillMarkers(fills, []), []);
});

test('several fills in one candle collapse to one stone per actor and side', () => {
  const k = candles(3);
  const at = k[1]!.openTime;
  const fills = [
    ...yourFills([mine(at), mine(at + 1), mine(at + 2, { side: 'sell' })], 'MON-USDC'),
    ...agentsFills([theirs(1, at + 3), theirs(2, at + 4)], 'MON-USDC'),
  ];
  assert.deepEqual(fillMarkers(fills, k), [
    { index: 1, who: 'you' },
    { index: 1, who: 'you' },
    { index: 1, who: 'agent' },
  ]);
});

test('only this market: fills in another symbol never reach the chart or the list', () => {
  const other = [mine(1, { symbol: 'ETH-USDC' }), mine(2, { symbol: null })];
  assert.deepEqual(yourFills(other, 'MON-USDC'), []);
  assert.deepEqual(agentsFills([theirs(1, 1, { symbol: 'ETH-USDC' })], 'MON-USDC'), []);
});

test('the list: newest first across both, capped, in the study words', () => {
  const now = new Date(2026, 8, 29, 12).getTime();
  const sep23 = new Date(2026, 8, 23, 12).getTime();
  const sep21 = new Date(2026, 8, 21, 12).getTime();
  const list = mergeFills(
    yourFills([mine(sep23), mine(sep21, { price: '0.938', size: '200' })], 'MON-USDC'),
    agentsFills([theirs(7, now - 3 * 3_600_000)], 'MON-USDC'),
    2,
  );
  assert.deepEqual(
    list.map((f) => [f.key, fillLine(f, MON.tickSize), fillWhen(f.at, now)]),
    [
      ['agent:7', 'Range Hunter bought 180 at 0.9744', '3h'],
      [`you:kuru:v-${sep23}`, 'You bought 212 at 0.9459', 'Sep 23'],
    ],
  );
  const sold = { ...list[0]!, side: 'sell' as const, price: null };
  assert.equal(fillLine(sold, MON.tickSize), 'Range Hunter sold 180');
  assert.equal(fillWhen(now - 30_000, now), 'now');
  assert.equal(fillWhen(now - 4 * MIN, now), '4m');
});
