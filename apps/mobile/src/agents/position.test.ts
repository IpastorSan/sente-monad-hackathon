/**
 * The agent position screen's figures and sentences (SEN-117). Plain node.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentPortfolioDto, PositionDto } from './api.ts';
import { toLedgerEntries, type LedgerEvent } from './ledger.ts';
import { presetLevels } from './levels.ts';
import {
  askChips,
  askInstruction,
  bestSince,
  chartLevels,
  composeAsk,
  entriesSince,
  fillMarkers,
  findPosition,
  fitsChart,
  latestThesis,
  levelDistances,
  moveLine,
  openedAt,
  roomToLiq,
  sizeLine,
  toggleChip,
  venueFor,
  watchLine,
} from './position.ts';

const NOW = Date.parse('2026-09-27T09:41:00.000Z');
const M = 60_000;

let seq = 0;
function event(kind: string, at: number, detail: Record<string, unknown>): LedgerEvent {
  seq += 1;
  return { seq, at, kind, detail };
}

/** Range Hunter's MON long: 120, then +60, with its thesis. */
function log() {
  seq = 0;
  return toLedgerEntries([
    event('thesis', NOW - 106 * M, {
      market: 'MON-USDC',
      direction: 'long',
      thesis: 'MON keeps bouncing between 0.95 and 1.01.',
      invalidation: 'MON loses 0.9460.',
    }),
    event('fill', NOW - 105 * M, { symbol: 'MON-USDC', side: 'buy', filledSize: '120' }),
    event('fill', NOW - 70 * M, { symbol: 'MON-USDC', side: 'buy', filledSize: '60' }),
    event('fill', NOW - 60 * M, { symbol: 'ETH-USDC', side: 'buy', filledSize: '1' }),
  ]);
}

const PERP: PositionDto = {
  symbol: 'MON-PERP',
  side: 'short',
  size: '400',
  entryPrice: '0.9920',
  markPrice: '0.9809',
  liquidationPriceEst: '1.4800',
  leverage: 2,
  margin: '198.40',
  unrealizedPnl: '4.44',
  realizedPnl: null,
  fundingPaid: '0.12',
  quote: 'AUSD',
  updatedAt: NOW,
};

function portfolio(): AgentPortfolioDto {
  return {
    agentId: 'a',
    address: '0x0',
    asOf: NOW,
    wallet: { ok: true, balances: [] },
    kuru: { ok: true, accountId: '1', balances: [], openOrders: [] },
    perpl: {
      ok: true,
      status: 'ok',
      accountId: '7',
      balances: [],
      openOrders: [],
      positions: [PERP],
    },
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
    totals: { approxUsd: '900', byQuote: { USDC: '600', AUSD: '300' }, note: '' },
  };
}

test('venueFor trusts the link, else reads the symbol', () => {
  assert.equal(venueFor('MON-PERP'), 'perpl');
  assert.equal(venueFor('MON-USDC'), 'kuru');
  assert.equal(venueFor('MON-USDC', 'perpl'), 'perpl');
  assert.equal(venueFor('MON-USDC', 'nonsense'), 'kuru');
});

test('findPosition: the spot long and the perp short, or nothing once closed', () => {
  const spot = findPosition(portfolio(), log(), null, 'MON-USDC');
  assert.equal(spot?.pnl, '+1.22');
  assert.equal(spot?.thesis, 'MON keeps bouncing between 0.95 and 1.01.');
  assert.equal(sizeLine(spot!), '180 MON · Kuru spot · USDC');
  assert.deepEqual(moveLine(spot!), { text: '+0.70% since entry', tone: 'up' });

  const perp = findPosition(portfolio(), [], null, 'MON-PERP');
  assert.equal(perp?.margin, '198.40');
  assert.equal(perp?.leverage, 2);
  assert.equal(perp?.fundingPaid, '0.12');
  assert.equal(sizeLine(perp!), '400 MON · Perpl · AUSD');
  assert.deepEqual(moveLine(perp!), { text: '+2.24% on margin', tone: 'up' });

  assert.equal(findPosition(portfolio(), [], null, 'SOL-PERP'), null);
});

test('levelDistances measures from the mark, and says so once a level is crossed', () => {
  const levels = presetLevels(
    { id: 'guardian', params: { sellAbove: 1.005, sellBelow: 0.946 } },
    { entry: '0.9744', side: 'long' },
  );
  assert.deepEqual(levelDistances(levels, '0.9812', 'long'), [
    { role: 'target', text: '2.4% to target' },
    { role: 'stop', text: '3.6% to stop' },
  ]);
  assert.deepEqual(
    levelDistances(levels, '0.9400', 'long').map((each) => each.text),
    ['6.9% to target', 'at stop'],
  );
  assert.deepEqual(levelDistances(levels, null, 'long'), []);
});

test('roomToLiq and the far-level rule: Basis Monk’s 2× short is 50.9% from liq', () => {
  assert.deepEqual(roomToLiq('0.9920', '0.9809', '1.4800'), { room: '50.9%', fill: 0 });
  assert.deepEqual(roomToLiq('1.00', '1.20', '1.50'), { room: '25.0%', fill: 0.4 });
  assert.equal(roomToLiq('1', '1', null), null);
  assert.equal(fitsChart('0.9809', '1.4800'), false);
  assert.equal(fitsChart('1.00', '1.10'), true);
  assert.equal(fitsChart('1.00', null), true);
});

test('chartLevels draws entry, the preset levels with their kind, and liq est', () => {
  const levels = presetLevels(
    { id: 'range-trader', params: { target: 3, stop: 3 } },
    { entry: '1.0000', side: 'long' },
  );
  assert.deepEqual(chartLevels('1.0000', levels, null), [
    { price: '1.0000', kind: 'entry', label: 'ENTRY' },
    { price: '1.0300', kind: 'tp', label: 'TARGET · ORDER' },
    { price: '0.9700', kind: 'sl', label: 'STOP · WATCHED' },
  ]);
  assert.deepEqual(chartLevels(null, [], '1.48'), [
    { price: '1.48', kind: 'liq', label: 'LIQ EST' },
  ]);
});

test('fillMarkers puts each of the agent’s fills on the candle it landed in', () => {
  const klines = Array.from({ length: 24 }, (_, i) => ({
    openTime: NOW - (24 - i) * 5 * M,
    closeTime: NOW - (23 - i) * 5 * M - 1,
  }));
  // 105 and 70 minutes ago: candles 3 and 10; ETH is another market.
  assert.deepEqual(fillMarkers(log(), 'MON-USDC', klines), [
    { index: 3, who: 'agent', label: '+120' },
    { index: 10, who: 'agent', label: '+60' },
  ]);
  // A window that starts after the first fill leaves it out.
  assert.deepEqual(
    fillMarkers(log(), 'MON-USDC', klines.slice(6)).map((m) => m.label),
    ['+60'],
  );
  assert.deepEqual(fillMarkers(log(), 'MON-USDC', []), []);
});

test('openedAt and bestSince feed the trailing stop', () => {
  assert.equal(openedAt(log(), 'MON-USDC', 'long'), NOW - 105 * M);
  assert.equal(openedAt(log(), 'SOL-PERP', 'long'), null);
  const klines = [
    { openTime: NOW - 20 * M, closeTime: NOW - 10 * M, high: '1.20', low: '0.90' },
    { openTime: NOW - 10 * M, closeTime: NOW, high: '1.10', low: '0.95' },
  ];
  assert.equal(bestSince(klines, NOW - 5 * M, 'long'), '1.10');
  assert.equal(bestSince(klines, NOW - 30 * M, 'long'), '1.20');
  assert.equal(bestSince(klines, NOW - 30 * M, 'short'), '0.90');
  assert.equal(bestSince(klines, null, 'long'), null);
});

test('latestThesis and watchLine', () => {
  assert.equal(latestThesis(log(), 'MON-USDC')?.invalidation, 'MON loses 0.9460.');
  assert.equal(latestThesis(log(), 'ETH-USDC'), null);
  const range = presetLevels({ id: 'range-trader', params: {} }, { entry: '1', side: 'long' });
  assert.equal(watchLine(range), 'At each check it exits if price has reached 0.9700.');
  assert.equal(watchLine([]), null);
});

test('the Ask sheet composes an instruction from exclusive chips, naming the position', () => {
  const position = { entry: '0.9744', side: 'long', size: '180', base: 'MON' } as const;
  const chips = askChips(position, true);
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ['Close it all', 'Close half', 'Stop to break-even', 'Why this entry?'],
  );
  assert.deepEqual(
    askChips(position, false).map((chip) => chip.key),
    ['close-all', 'close-half', 'why'],
  );
  assert.deepEqual(
    askChips(null, true).map((chip) => chip.key),
    ['why'],
  );

  let selected = toggleChip([], 'break-even', chips);
  selected = toggleChip(selected, 'close-all', chips);
  selected = toggleChip(selected, 'close-half', chips);
  assert.deepEqual(selected, ['close-half', 'break-even']);
  assert.equal(
    composeAsk(selected, chips),
    'Close half of it and move the stop to break-even (0.9744)',
  );
  assert.deepEqual(toggleChip(selected, 'close-half', chips), ['break-even']);

  assert.equal(
    askInstruction(position, 'MON-USDC', '  Close half  '),
    'About your long MON-USDC position (180 MON at 0.9744): Close half',
  );
  assert.equal(askInstruction(null, 'MON-USDC', 'Why?'), 'About MON-USDC: Why?');
});

test('entriesSince keeps only what the run added', () => {
  assert.deepEqual(
    entriesSince(log(), 2).map((entry) => entry.seq),
    [3, 4],
  );
});
