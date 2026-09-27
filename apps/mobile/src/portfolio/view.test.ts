/** Portfolio tab rules (SEN-118). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentPortfolioDto, OrderDto, PositionDto } from '../agents/api.ts';
import type { TickerDto } from '../markets/api.ts';
import type { Portfolio, PortfolioFill } from '../trade/types.ts';
import {
  agentGroup,
  allocation,
  allocationParts,
  amountText,
  appendSample,
  approxUsd,
  fillDays,
  findPosition,
  holdings,
  legendValue,
  mulDecimal,
  orderRows,
  perpDetail,
  sectionFailure,
  seriesChange,
  shown,
  signedUsd,
  subDecimal,
  unreadSections,
  usdPrice,
} from './view.ts';

const NOW = Date.UTC(2026, 8, 27, 9, 41);

function ticker(symbol: string, last: string, venue: 'kuru' | 'perpl' = 'kuru'): TickerDto {
  return {
    venue,
    symbol,
    quote: venue === 'kuru' ? 'USDC' : 'AUSD',
    last,
    mark: venue === 'perpl' ? last : null,
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
    asOf: NOW,
  };
}

const TICKERS = [ticker('MON-USDC', '0.9812'), ticker('ETH-PERP', '2544.10', 'perpl')];

const ETH: PositionDto = {
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

const MON_BUY: OrderDto = {
  venue: 'kuru',
  id: '1:42',
  symbol: 'MON-USDC',
  side: 'buy',
  type: 'limit',
  status: 'open',
  price: '0.9500',
  size: '150',
  filledSize: '0',
  leverage: null,
  createdAt: Date.UTC(2026, 8, 27, 9, 14),
  updatedAt: Date.UTC(2026, 8, 27, 9, 14),
};

function portfolio(overrides: Partial<Portfolio> = {}): Portfolio {
  return {
    asOf: NOW,
    wallet: {
      ok: true,
      balances: [
        { symbol: 'MON', address: '0x0', decimals: 18, raw: '0', amount: '412.42' },
        { symbol: 'USDC', address: '0x1', decimals: 6, raw: '0', amount: '500' },
        { symbol: 'AUSD', address: '0x2', decimals: 6, raw: '0', amount: '1284.5' },
        { symbol: 'XAUt', address: '0x3', decimals: 6, raw: '0', amount: '0' },
      ],
    },
    kuru: {
      ok: true,
      accountId: '7',
      balances: [{ asset: 'USDC', available: '0', locked: '142.5', total: '142.5' }],
      openOrders: [MON_BUY],
    },
    perpl: {
      ok: true,
      status: 'ok',
      accountId: '9',
      balances: [{ asset: 'AUSD', available: '100', locked: '0', total: '308.17' }],
      positions: [ETH],
      openOrders: [],
    },
    ...overrides,
  };
}

/** What `useUserPortfolio` hands `holdings`: the wallet section's balances. */
function walletOf(p: Portfolio) {
  return p.wallet.ok ? p.wallet.balances : [];
}

test('exact decimal maths never goes through a float', () => {
  assert.equal(mulDecimal('412', '0.9812'), '404.2544');
  assert.equal(mulDecimal('0.1', '0.2'), '0.02');
  assert.equal(subDecimal('0.3', '0.1'), '0.2');
  assert.equal(subDecimal('1', '-2'), '3');
  assert.equal(mulDecimal('x', '1'), null);
});

test('USDC and AUSD are $1, other assets take their Kuru last price, the rest are unpriced', () => {
  assert.equal(usdPrice('AUSD', []), '1');
  assert.equal(usdPrice('USDC', []), '1');
  assert.equal(usdPrice('MON', TICKERS), '0.9812');
  assert.equal(usdPrice('WETH', TICKERS), null);
});

test('balances truncate to their token places, totals round and say ≈ $', () => {
  assert.equal(amountText('0.009', 'AUSD'), '0.00');
  assert.equal(amountText('1284.5', 'AUSD'), '1,284.50');
  assert.equal(amountText('412.123456', 'MON'), '412.1234');
  assert.equal(approxUsd('3918.4'), '≈ $3,918.40');
  assert.equal(approxUsd(null), '—');
});

test('holdings: cash per currency, venue cash, spot at the Kuru price, perps as margin + uPnL', () => {
  const held = holdings(walletOf(portfolio()), portfolio(), TICKERS);
  assert.deepEqual(held.cash, [
    { symbol: 'AUSD', amount: '1284.5', purpose: 'for perps' },
    { symbol: 'USDC', amount: '500', purpose: 'for spot' },
  ]);
  // Perpl's balance includes the position's margin, which the perp row counts.
  assert.deepEqual(held.venueCash, [
    { venue: 'kuru', asset: 'USDC', amount: '142.5' },
    { venue: 'perpl', asset: 'AUSD', amount: '100.00' },
  ]);
  assert.deepEqual(held.spot, [
    { asset: 'MON', amount: '412.42', price: '0.9812', value: '404.666504' },
  ]);
  assert.equal(held.perps[0]?.value, '219.70');
  assert.ok(Math.abs((held.perps[0]?.pctOnMargin ?? 0) - 5.5387) < 0.001);
  assert.deepEqual(held.unpriced, []);
  assert.equal(held.perpsUnknown, false);
});

test('an unpriced asset is named and left out, never counted as zero', () => {
  const p = portfolio({
    wallet: {
      ok: true,
      balances: [{ symbol: 'WETH', address: '0x4', decimals: 18, raw: '0', amount: '1.5' }],
    },
  });
  const held = holdings(walletOf(p), p, TICKERS);
  assert.deepEqual(held.unpriced, ['WETH']);
  assert.equal(held.spot[0]?.value, null);
  assert.equal(allocationParts(held, null).spot, '0');
});

test('unlinked Perpl: the chain balance is cash and perps are unknown', () => {
  const p = portfolio({
    perpl: {
      ok: true,
      status: 'unlinked',
      accountId: '9',
      balances: [{ asset: 'AUSD', available: '50', locked: '0', total: '50' }],
    },
  });
  const held = holdings(walletOf(p), p, TICKERS);
  assert.equal(held.perpsUnknown, true);
  assert.deepEqual(held.perps, []);
  assert.deepEqual(held.venueCash.at(-1), { venue: 'perpl', asset: 'AUSD', amount: '50' });
});

test('a failed Kuru section is named, not counted as an empty account (SEN-123)', () => {
  const p = portfolio({ kuru: { ok: false, error: 'Gateway 503' } });
  const held = holdings(walletOf(p), p, TICKERS);
  assert.deepEqual(held.unread, ['kuru']);
  // The wallet and Perpl are still there, whole.
  assert.equal(held.cash[1]?.amount, '500');
  assert.equal(held.spot[0]?.amount, '412.42');
  assert.equal(held.perps[0]?.value, '219.70');
  assert.deepEqual(held.venueCash, [{ venue: 'perpl', asset: 'AUSD', amount: '100.00' }]);
  // Its orders are unknown, so none are listed; Perpl's would be.
  assert.deepEqual(orderRows(p, TICKERS, NOW), []);
  assert.equal(sectionFailure('kuru').title, 'Kuru didn’t answer — pull to retry');
});

test('a failed Perpl section leaves perps unknown, not flat (SEN-123)', () => {
  const p = portfolio({ perpl: { ok: false, error: 'socket refused' } });
  const held = holdings(walletOf(p), p, TICKERS);
  assert.deepEqual(held.unread, ['perpl']);
  assert.deepEqual(held.perps, []);
  assert.equal(findPosition(held, 'perpl', 'ETH-PERP'), null);
  assert.deepEqual(held.venueCash, [{ venue: 'kuru', asset: 'USDC', amount: '142.5' }]);
  assert.equal(orderRows(p, TICKERS, NOW).length, 1);
  assert.match(sectionFailure('perpl').title, /^Perpl didn’t answer/u);
});

test('unreadSections lists every failed section in display order', () => {
  assert.deepEqual(unreadSections(portfolio()), []);
  assert.deepEqual(unreadSections(null), []);
  assert.deepEqual(
    unreadSections(
      portfolio({
        wallet: { ok: false, error: 'x' },
        perpl: { ok: false, error: 'y' },
      }),
    ),
    ['wallet', 'perpl'],
  );
});

test('trading off: wallet cash alone, from the wallet session', () => {
  const held = holdings(
    [
      { symbol: 'AUSD', amount: '10' },
      { symbol: 'MON', amount: '0.42' },
    ],
    null,
    TICKERS,
  );
  assert.equal(held.cash[0]?.amount, '10');
  assert.equal(held.cash[1]?.amount, '0');
  assert.equal(held.spot[0]?.asset, 'MON');
  assert.deepEqual(held.perps, []);
});

test('allocation shares are whole percents that add to 100, empty parts left out', () => {
  const split = allocation({ cash: '1784.91', agents: '1509.54', spot: '404.25', perps: '219.70' });
  assert.equal(split.total, '3918.40');
  assert.deepEqual(
    split.segments.map((s) => [s.key, s.share]),
    [
      ['cash', 46],
      ['agents', 38],
      ['spot', 10],
      ['perps', 6],
    ],
  );
  assert.equal(
    split.segments.reduce((a, s) => a + s.share, 0),
    100,
  );
  const thirds = allocation({ cash: '1', agents: '1', spot: '1', perps: '0' });
  assert.deepEqual(
    thirds.segments.map((s) => s.share),
    [34, 33, 33],
  );
  assert.deepEqual(allocation({ cash: '0', agents: '0', spot: '0', perps: '0' }).segments, []);
});

test('hidden balances: digits masked, the legend switches to shares', () => {
  const [cash] = allocation({ cash: '1784.91', agents: '0', spot: '0', perps: '0' }).segments;
  assert.ok(cash);
  assert.equal(legendValue(cash, false), '$1,784.91');
  assert.equal(legendValue(cash, true), '100%');
  assert.equal(shown('1,284.50', true), '•,•••.••');
  assert.equal(shown('1,284.50', false), '1,284.50');
});

test('the hero series keeps the newest samples and reports first → last', () => {
  let series = appendSample([], { at: 0, usd: '100' });
  series = appendSample(series, { at: 1_000, usd: '101' }); // within the gap: replaces
  assert.deepEqual(series, [{ at: 1_000, usd: '101' }]);
  series = appendSample(series, { at: 10_000, usd: '99.99' });
  assert.equal(series.length, 2);
  const change = seriesChange(series);
  assert.equal(change?.delta, '-1.01');
  assert.equal(change?.tone, 'down');
  assert.equal(signedUsd('-1.01'), '−$1.01');
  assert.equal(signedUsd('84.12'), '+$84.12');
  assert.equal(seriesChange(series.slice(0, 1)), null);
  const capped = [0, 10_000, 20_000].reduce(
    (s, at) => appendSample(s, { at, usd: '1' }, { max: 2 }),
    [] as { at: number; usd: string }[],
  );
  assert.deepEqual(
    capped.map((s) => s.at),
    [10_000, 20_000],
  );
});

function agentPortfolio(overrides: Partial<AgentPortfolioDto> = {}): AgentPortfolioDto {
  return {
    agentId: 'a1',
    address: '0xa',
    asOf: NOW,
    wallet: { ok: true, balances: [] },
    kuru: { ok: true, accountId: null, balances: [], openOrders: [] },
    perpl: { ok: true, status: 'no_account' },
    holdings: [
      {
        asset: 'MON',
        market: 'MON-USDC',
        amount: '180',
        inWallet: '180',
        inAccount: '0',
        lockedInOrders: '0',
        markPrice: '0.9812',
        value: '176.616',
        costBasis: {
          avgPrice: '0.9744',
          coveredSize: '180',
          uncoveredSize: '0',
          unrealizedPnl: '1.224',
          complete: true,
          source: 'event-log-fifo',
        },
      },
    ],
    totals: { approxUsd: '612.40', byQuote: { USDC: '612.40', AUSD: '0' }, note: '' },
    ...overrides,
  };
}

test('agents group: positions open the cockpit, idle agents show their ≈ $, revoked only with funds', () => {
  const { rows, total } = agentGroup([
    {
      agent: { id: 'a1', name: 'Range Hunter', status: 'active' },
      portfolio: agentPortfolio(),
    },
    {
      agent: { id: 'a2', name: 'Quiet', status: 'active' },
      portfolio: agentPortfolio({
        holdings: [],
        totals: { ...agentPortfolio().totals, approxUsd: '5' },
      }),
    },
    {
      agent: {
        id: 'a3',
        name: 'Night Shift',
        status: 'revoked',
        revokedAt: '2026-09-23T10:00:00.000Z',
      },
      portfolio: agentPortfolio({
        holdings: [],
        totals: { ...agentPortfolio().totals, approxUsd: '412' },
      }),
    },
    {
      agent: { id: 'a4', name: 'Empty', status: 'revoked' },
      portfolio: agentPortfolio({
        holdings: [],
        totals: { ...agentPortfolio().totals, approxUsd: '0' },
      }),
    },
    { agent: { id: 'a5', name: 'Old API', status: 'active' }, portfolio: null },
  ]);
  assert.equal(total, '1029.40');
  assert.deepEqual(
    rows.map((r) =>
      r.kind === 'position' ? `${r.agentId}:${r.symbol}` : `${r.agentId}:${r.caption}`,
    ),
    ['a1:MON', 'a2:No open position', 'a3:Revoked Sep 23', 'a5:Holdings unavailable'],
  );
  const [position] = rows;
  assert.equal(position?.kind, 'position');
  if (position?.kind === 'position') {
    assert.equal(position.caption, 'Range Hunter · from 0.9744');
    assert.equal(position.unit, 'USDC');
    assert.ok(Math.abs((position.pct ?? 0) - 0.6979) < 0.001);
  }
  const revoked = rows[2];
  assert.equal(revoked?.kind === 'agent' && revoked.aside, 'ready to return');
});

test('orders: distance to the market, what cancelling returns, when it was placed', () => {
  const [row] = orderRows(portfolio(), TICKERS, NOW);
  assert.ok(row);
  assert.equal(row.kind, 'Limit · MON-USDC · Kuru spot');
  assert.equal(row.distance, 'Fills if MON drops 3.18%.');
  assert.equal(row.backToCash, '142.50 USDC');
  assert.equal(row.filledLine, '0.0000 of 150.0000 filled so far');
  assert.equal(row.placed, 'Today 09:14 · good till cancelled');
  assert.ok(row.track && row.track.limit < row.track.market);

  const [sell] = orderRows(
    portfolio({
      kuru: {
        ok: true,
        accountId: '7',
        balances: [],
        openOrders: [{ ...MON_BUY, side: 'sell', price: '0.9', filledSize: '50' }],
      },
    }),
    TICKERS,
    NOW,
  );
  assert.equal(sell?.distance, 'At or through the market: it should fill on the next match.');
  assert.equal(sell?.backToCash, '100.0000 MON');
  assert.deepEqual(orderRows(null, TICKERS, NOW), []);
});

test('history: fills grouped by UTC day, newest first, with the chain hash', () => {
  const fill = (at: number, over: Partial<PortfolioFill> = {}): PortfolioFill => ({
    venue: 'kuru',
    tradeId: `t${at}`,
    venueTradeId: 'v',
    orderId: null,
    symbol: 'MON-USDC',
    side: 'buy',
    price: '0.9420',
    size: '412',
    transactionHash: '0x5d02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae7f9',
    timestamp: at,
    ...over,
  });
  const days = fillDays(
    [
      fill(Date.UTC(2026, 8, 25, 14, 12), {
        venue: 'perpl',
        symbol: 'ETH-PERP',
        size: '0.25',
        price: '2498.00',
        transactionHash: null,
      }),
      fill(Date.UTC(2026, 8, 27, 9, 0), { side: null, symbol: null }),
      fill(Date.UTC(2026, 8, 26, 10, 5)),
    ],
    NOW,
  );
  assert.deepEqual(
    days.map((d) => d.label),
    ['Today', 'Yesterday', 'Fri, Sep 25'],
  );
  assert.deepEqual(days[0]?.fills[0], {
    key: `kuru:t${Date.UTC(2026, 8, 27, 9, 0)}:v`,
    side: null,
    title: '412',
    detail: 'at 0.9420 · Kuru spot',
    time: '09:00',
    tx: '0x5d02…e7f9',
    hash: '0x5d02aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaae7f9',
  });
  assert.equal(days[1]?.fills[0]?.title, '412.0000 MON');
  assert.equal(days[2]?.fills[0]?.title, '0.25 ETH-PERP');
  assert.equal(days[2]?.fills[0]?.detail, 'at 2498.00 · Perpl');
  assert.equal(days[2]?.fills[0]?.tx, null);
});

test('your perp: P&L on margin, notional at the mark, liquidation est. with its distance', () => {
  const detail = perpDetail(ETH);
  assert.deepEqual(detail.pnl, { sign: '+', magnitude: '11.53', tone: 'up' });
  assert.equal(detail.pct, '+5.54%');
  assert.equal(detail.size, '0.25 ETH · 636.03 AUSD');
  assert.equal(detail.margin, '208.17 AUSD · 3×');
  assert.equal(detail.funding, '−0.38 AUSD');
  assert.equal(detail.liq, 'LIQ est. 1,690.00 · 33.6% below');
  const short = perpDetail({
    ...ETH,
    side: 'short',
    liquidationPriceEst: '3000',
    unrealizedPnl: '-4.1',
  });
  assert.equal(short.liq, 'LIQ est. 3,000.00 · 17.9% above');
  assert.equal(short.pnl.sign, '−');
  assert.equal(perpDetail({ ...ETH, liquidationPriceEst: null }).liq, null);
  assert.equal(perpDetail(ETH, true).size, '•.•• ETH · •••.•• AUSD');
});

test('findPosition looks up your perp by symbol and your spot by base asset', () => {
  const held = holdings(walletOf(portfolio()), portfolio(), TICKERS);
  assert.equal(findPosition(held, 'perpl', 'ETH-PERP')?.kind, 'perp');
  assert.equal(findPosition(held, 'kuru', 'MON')?.kind, 'spot');
  assert.equal(findPosition(held, 'kuru', 'MON-USDC')?.kind, 'spot');
  assert.equal(findPosition(held, 'perpl', 'BTC-PERP'), null);
  assert.equal(findPosition(held, 'nope', 'MON'), null);
});
