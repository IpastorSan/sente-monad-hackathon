/**
 * The agent cockpit's words and figures (SEN-115). Plain node, no device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMandate, AgentPortfolioDto, AgentScheduleStatusDto } from './api.ts';
import {
  bestTrades,
  cockpitStats,
  countsSince,
  equitySeries,
  historyDays,
  largestOrderLine,
  mandateSigned,
  pnlUnit,
  positionRows,
  rulesSentence,
  scheduleLine,
  settledTrades,
  signedParts,
  tabFrom,
  trackLayout,
  watchedLevels,
} from './cockpit.ts';
import { toLedgerEntries, type LedgerEvent } from './ledger.ts';

const NOW = Date.parse('2026-09-27T12:00:00.000Z');
const H = 3_600_000;
const MON_USDC = '0xfdbE356828c8f5A5d5ed4f69ddE0816f4058Ef61';
const USDC = '0xEe0722ead54f1B4fe97bE399Be43BC0226a6f97E';

let seq = 0;
function event(kind: string, at: number, detail: Record<string, unknown>): LedgerEvent {
  seq += 1;
  return { seq, at, kind, detail };
}

/** Two closed longs on MON (a win and a loss), one refusal, and an open thesis. */
function log() {
  seq = 0;
  return toLedgerEntries([
    event('thesis', NOW - 50 * H, { market: 'MON-USDC', direction: 'long', thesis: 'Floor.' }),
    event('fill', NOW - 48 * H, { symbol: 'MON-USDC', side: 'buy', filledSize: '100' }),
    event('close', NOW - 45 * H, { symbol: 'MON-USDC', side: 'sell', realizedPnl: '-2.60' }),
    event('verdict', NOW - 45 * H, { market: 'MON-USDC', direction: 'long', realisedPnl: '-2.52' }),
    event('refusal', NOW - 10 * H, { code: 'over_cap', message: 'Too big.' }),
    event('fill', NOW - 4 * H, { symbol: 'MON-USDC', side: 'buy', filledSize: '180' }),
    event('verdict', NOW - 2 * H, { market: 'MON-USDC', direction: 'long', realisedPnl: '18.22' }),
    event('thesis', NOW - H, { market: 'MON-USDC', direction: 'long', thesis: 'Range again.' }),
  ]);
}

test('tabFrom opens Overview for anything it does not know', () => {
  assert.equal(tabFrom('history'), 'history');
  assert.equal(tabFrom('mandate'), 'mandate');
  assert.equal(tabFrom('ledger'), 'overview');
  assert.equal(tabFrom(undefined), 'overview');
});

test('settledTrades counts verdicts only, never the close before one, with the hold', () => {
  const trades = settledTrades(log());
  assert.deepEqual(
    trades.map((trade) => [trade.pnl, trade.tone, trade.holdMs]),
    [
      ['-2.52', 'down', 3 * H],
      ['18.22', 'up', 2 * H],
    ],
  );
});

test('cockpitStats: won of settled, average hold, held from the summary when there is one', () => {
  const entries = log();
  const trades = settledTrades(entries);
  assert.deepEqual(cockpitStats(trades, entries, { held: 4 }, '2026-09-21T08:00:00.000Z'), {
    won: '1 of 2',
    avgHold: '2h 30m',
    held: '4',
    liveSince: 'Sep 21',
  });
  assert.deepEqual(cockpitStats([], [], undefined, 'not a date'), {
    won: '—',
    avgHold: '—',
    held: '0',
    liveSince: '—',
  });
  assert.equal(cockpitStats(trades, entries, undefined, '2026-09-21T00:00:00Z').held, '1');
});

test('cockpitStats says since when the summary counts only part of the history (SEN-159)', () => {
  const summary = { held: 4, countsPartial: { since: Date.parse('2026-09-03T12:00:00Z') } };
  assert.equal(cockpitStats([], [], summary, '2026-09-01T00:00:00Z').held, '4 since Sep 3');
  assert.equal(countsSince(summary), ' since Sep 3');
  assert.equal(countsSince({}), '');
  assert.equal(countsSince(undefined), '');
});

test('signedParts splits the sign off for the big number', () => {
  assert.deepEqual(signedParts('42.18'), { sign: '+', magnitude: '42.18', tone: 'up' });
  assert.deepEqual(signedParts('-2.5'), { sign: '−', magnitude: '2.50', tone: 'down' });
  assert.deepEqual(signedParts(undefined), { sign: '', magnitude: '0.00', tone: null });
});

test('signedParts signs and tones the cent BigNumber shows, not the exact figure (SEN-136)', () => {
  // Pre-fix: `−` + berry over a BigNumber reading `0.00`.
  assert.deepEqual(signedParts('-0.001'), { sign: '', magnitude: '0.00', tone: null });
  // Pre-fix: the raw `1e-7` reached BigNumber, which printed `—`.
  assert.deepEqual(signedParts('1e-7'), { sign: '', magnitude: '0.00', tone: null });
  // Pre-fix: the unrounded magnitude; half away from zero on the digits.
  assert.deepEqual(signedParts('-2.675'), { sign: '−', magnitude: '2.68', tone: 'down' });
});

test('pnlUnit names one venue’s quote, and only approximates across both', () => {
  assert.deepEqual(pnlUnit(['kuru']), { unit: 'USDC', approx: false });
  assert.deepEqual(pnlUnit(['perpl']), { unit: 'AUSD', approx: false });
  assert.deepEqual(pnlUnit(['kuru', 'perpl']), { unit: '', approx: true });
});

test('equitySeries steps cumulative P&L from where the window opened', () => {
  const trades = settledTrades(log());
  const all = equitySeries(trades, 'All', NOW, NOW - 100 * H);
  assert.deepEqual(all?.points, ['0', '-2.52', '15.70']);
  assert.equal(all?.ats[0], NOW - 100 * H);

  // The 1D window starts from the loss already on the books.
  assert.deepEqual(equitySeries(trades, '1D', NOW, NOW - 100 * H)?.points, ['-2.52', '15.70']);
  assert.equal(equitySeries([], 'All', NOW, NOW - H), null);
});

test('watchedLevels applies Range Trader percents to the entry, either side, and Guardian lines as is', () => {
  const range = { id: 'range-trader', params: { target: 3, stop: 2 } };
  assert.deepEqual(watchedLevels(range, '1.0000', 'long'), { target: '1.0300', stop: '0.9800' });
  assert.deepEqual(watchedLevels(range, '1.0000', 'short'), { target: '0.9700', stop: '1.0200' });
  assert.deepEqual(
    watchedLevels({ id: 'guardian', params: { sellAbove: 0.05, sellBelow: 0.01 } }, '0.03', 'long'),
    { target: '0.05', stop: '0.01' },
  );
  assert.equal(watchedLevels({ id: 'dca-stacker', params: {} }, '1', 'long'), null);
  assert.equal(watchedLevels({ id: 'range-trader', params: { target: 'x' } }, '1', 'long'), null);
  assert.equal(watchedLevels(null, '1', 'long'), null);
});

test('trackLayout places entry and price from the stop end, clamped', () => {
  assert.deepEqual(trackLayout({ stop: '0.9', target: '1.1' }, '1.0', '1.05'), {
    entry: 0.5,
    mark: 0.75,
  });
  // A short: target below stop, progress still reads toward the target.
  assert.deepEqual(trackLayout({ stop: '1.1', target: '0.9' }, '1.0', '0.8'), {
    entry: 0.5,
    mark: 1,
  });
  assert.equal(trackLayout({ stop: '1', target: '1' }, '1', '1'), null);
});

function portfolio(overrides: Partial<AgentPortfolioDto> = {}): AgentPortfolioDto {
  return {
    agentId: 'a',
    address: '0x1',
    asOf: NOW,
    wallet: { ok: true, balances: [] },
    kuru: { ok: true, accountId: '1', balances: [], openOrders: [] },
    perpl: { ok: true, status: 'not_in_mandate' },
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
      {
        // Gas MON the log does not explain: not a position.
        asset: 'MON',
        market: 'MON-USDC',
        amount: '0.4',
        inWallet: '0.4',
        inAccount: '0',
        lockedInOrders: '0',
        markPrice: '0.98',
        value: '0.39',
        costBasis: {
          avgPrice: null,
          coveredSize: '0',
          uncoveredSize: '0.4',
          unrealizedPnl: null,
          complete: false,
          source: 'event-log-fifo',
        },
      },
    ],
    totals: { approxUsd: '612.40', byQuote: { USDC: '612.40', AUSD: '0' }, note: '' },
    ...overrides,
  };
}

test('positionRows: explained Kuru holdings and Perpl positions, with the latest thesis', () => {
  const rows = positionRows(portfolio(), log(), {
    id: 'range-trader',
    version: 1,
    name: 'Range Trader',
    params: { target: 3, stop: 3 },
    customized: false,
  });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row?.detail, '180 MON @ 0.9744 · Kuru');
  assert.equal(row?.pnl, '+1.22');
  assert.equal(row?.pct, '+0.70%');
  assert.equal(row?.thesis, 'Range again.');
  assert.deepEqual(row?.levels, { target: '1.0036', stop: '0.9452' });
  // SEN-117: Range Trader's target is a real order, so the track must not call it watched.
  assert.equal(
    row?.levelsNote,
    'Target rests on Kuru as a limit order; stop is checked each run, not an order.',
  );

  const perp = positionRows(
    portfolio({
      holdings: [],
      perpl: {
        ok: true,
        status: 'ok',
        accountId: '7',
        balances: [],
        openOrders: [],
        positions: [
          {
            symbol: 'MON-PERP',
            side: 'short',
            size: '100',
            entryPrice: '1.00',
            markPrice: '1.02',
            liquidationPriceEst: '1.45',
            leverage: 2,
            margin: '50',
            unrealizedPnl: '-2',
            realizedPnl: null,
            fundingPaid: null,
            quote: 'AUSD',
            updatedAt: NOW,
          },
        ],
      },
    }),
    [],
    null,
  );
  assert.deepEqual(
    perp.map((row) => [row.detail, row.pnl, row.pct, row.tone, row.liq, row.levels]),
    [['100 MON @ 1.00 · Perpl 2×', '−2.00', '−2.00%', 'down', '1.45', null]],
  );
});

test('bestTrades ranks winners only, with hold and date', () => {
  assert.deepEqual(bestTrades(settledTrades(log())), [
    { seq: 7, title: 'Trade #1 · MON long', pnl: '+18.22', caption: 'held 2h · Sep 27' },
  ]);
});

test('historyDays groups newest first, with each day’s realised total', () => {
  const days = historyDays(log(), NOW);
  assert.deepEqual(
    days.map((day) => [day.label, day.pnl, day.tone, day.entries.length]),
    [
      ['Today · Sep 27', '+18.22', 'up', 4],
      ['Sep 25', '−2.52', 'down', 4],
    ],
  );
  assert.equal(days[0]?.entries[0]?.kind, 'thesis');
});

const MANDATE: AgentMandate = {
  version: 1,
  chainId: 10143,
  expiresAt: Date.parse('2026-10-05T00:00:00Z') / 1000,
  venues: ['kuru'],
  kuru: { markets: [MON_USDC], maxDepositAtoms: {} },
  perpl: { maxCollateralAtoms: 0n, maxLeverage: 1, markets: [] },
  maxOrderNotional: '250',
  rollingCap: { windowSeconds: 86_400, capAtoms: 400_000_000n, token: USDC },
  returnTo: '0x2222222222222222222222222222222222222222',
};

test('rulesSentence reads the mandate as one sentence, limits in bold', () => {
  const parts = rulesSentence({ name: 'Range Hunter', mandate: MANDATE });
  assert.equal(
    parts.map((part) => part.text).join(''),
    'Range Hunter may trade MON-USDC on Kuru spot, up to 250 USDC an order and 400 USDC a day, ' +
      'with no leverage, until Oct 5. Its funds can only go back to you.',
  );
  assert.deepEqual(
    parts.filter((part) => part.strong).map((part) => part.text),
    ['MON-USDC on Kuru spot', '250 USDC an order', '400 USDC a day', 'Oct 5'],
  );

  const perps = rulesSentence({
    name: 'Basis Monk',
    mandate: {
      ...MANDATE,
      venues: ['perpl'],
      perpl: { maxCollateralAtoms: 1n, maxLeverage: 3, markets: ['BTC-PERP'] },
      rollingCap: undefined,
      returnTo: undefined,
    },
  })
    .map((part) => part.text)
    .join('');
  assert.equal(
    perps,
    'Basis Monk may trade BTC-PERP on Perpl perps, up to 250 AUSD an order, up to 3× leverage, ' +
      'until Oct 5. It has no way to send funds back — amend it to add one.',
  );
});

test('mandateSigned says when it was signed and last amended', () => {
  const hired = '2026-09-21T08:00:00.000Z';
  assert.equal(mandateSigned(hired, Date.parse(hired) + 1000), 'signed Sep 21');
  assert.equal(
    mandateSigned(hired, Date.parse('2026-09-26T10:00:00Z')),
    'signed Sep 21 · amended Sep 26',
  );
  assert.equal(mandateSigned(hired, undefined), 'signed Sep 21');
});

test('largestOrderLine is order size against the cap, in the mandate’s quote', () => {
  assert.equal(largestOrderLine({ largestOrderNotional: '180' }, MANDATE), '180 of 250 USDC');
  assert.equal(largestOrderLine({ largestOrderNotional: null }, MANDATE), 'none yet, cap 250 USDC');
  assert.equal(largestOrderLine(undefined, MANDATE), 'cap 250 USDC');
});

test('scheduleLine: next check, pauses, manual, and the record alone without the route', () => {
  const status = (over: Partial<AgentScheduleStatusDto>): AgentScheduleStatusDto => ({
    everySeconds: 900,
    source: 'agent',
    lastRunAt: null,
    nextRunAt: new Date(NOW + 12 * 60_000).toISOString(),
    paused: null,
    ...over,
  });
  assert.equal(
    scheduleLine(status({}), null, NOW),
    'Checks the markets every 15m. Next check in 12m.',
  );
  assert.equal(
    scheduleLine(
      status({ source: 'global', nextRunAt: new Date(NOW - 1).toISOString() }),
      null,
      NOW,
    ),
    'Checks the markets every 15m (Sente’s default). Next check is due now.',
  );
  assert.equal(
    scheduleLine(
      status({ paused: { reason: 'credits_low', until: new Date(NOW + 3 * H).toISOString() } }),
      null,
      NOW,
    ),
    'Paused because credits are low, for 3h.',
  );
  assert.equal(
    scheduleLine(status({ everySeconds: null, source: null, nextRunAt: null }), null, NOW),
    'Runs only when you run it.',
  );
  assert.equal(scheduleLine(null, { everySeconds: 3600 }, NOW), 'Checks the markets every 1h.');
  assert.equal(scheduleLine(null, null, NOW), 'Runs only when you run it.');
});
