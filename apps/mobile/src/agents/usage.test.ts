/** The agent screens' gauge math and one-line summaries (SEN-58). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMandate, AgentSummary, WireAgentEvent } from './api.ts';
import {
  compareDecimals,
  describeMove,
  expiryUsage,
  formatDuration,
  formatHolding,
  holdsReturnable,
  isTrading,
  mainHolding,
  orderUsage,
  pnlTone,
  relativeAge,
  usedFraction,
  venuesCaption,
} from './usage.ts';

const NOW = Date.UTC(2026, 8, 26, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const mandate: AgentMandate = {
  version: 1,
  chainId: 10143,
  expiresAt: Math.floor((NOW + 5 * DAY + 14 * HOUR) / 1000),
  venues: ['kuru'],
  kuru: { markets: [], maxDepositAtoms: {} },
  perpl: { maxCollateralAtoms: 0n, maxLeverage: 2, markets: [] },
  maxOrderNotional: '250',
};

function summary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    agentId: 'a1',
    trades: 0,
    held: 0,
    theses: 0,
    pnl: { last24h: '0', allTime: '0' },
    largestOrderNotional: null,
    mandateSince: NOW - DAY,
    lastEvent: null,
    ...overrides,
  };
}

function event(kind: string, detail: Record<string, unknown>, extra = {}): WireAgentEvent {
  return { seq: 1, agentId: 'a1', at: NOW - 4 * 60_000, kind, detail, ...extra };
}

test('compareDecimals is exact where a float would not be', () => {
  assert.equal(compareDecimals('0.1', '0.10'), 0);
  assert.equal(compareDecimals('250', '250.000001'), -1);
  assert.equal(compareDecimals('9007199254740993', '9007199254740992'), 1);
  assert.equal(compareDecimals('abc', '1'), null);
});

test('pnlTone reads the sign of a decimal string and treats zero as neither', () => {
  assert.equal(pnlTone('18.22'), 'up');
  assert.equal(pnlTone('-4.10'), 'down');
  assert.equal(pnlTone('0'), null);
  assert.equal(pnlTone('-0.00'), null);
  assert.equal(pnlTone(null), null);
});

test('usedFraction clamps to 0..1 and treats no usage as empty', () => {
  assert.equal(usedFraction('180', '250'), 0.72);
  assert.equal(usedFraction(null, '250'), 0);
  assert.equal(usedFraction('480', '250'), 1);
  assert.equal(usedFraction('250', '250'), 1);
  assert.equal(usedFraction('0', '0'), 0);
  assert.equal(usedFraction('1', '0'), 1);
});

test('orderUsage shows the cap with nothing used when there is no summary', () => {
  const reading = orderUsage(undefined, mandate);
  assert.deepEqual(reading, { used: 0, value: '0 / 250', over: false, measured: false });
});

test('orderUsage reads the largest order against the cap, and says when it is past it', () => {
  assert.deepEqual(orderUsage(summary({ largestOrderNotional: '180.50' }), mandate), {
    used: 0.722,
    value: '180.5 / 250',
    over: false,
    measured: true,
  });
  const over = orderUsage(summary({ largestOrderNotional: '1480' }), mandate);
  assert.equal(over.used, 1);
  assert.equal(over.over, true);
  assert.equal(over.value, '1,480 / 250');
});

test('formatDuration keeps two units at most', () => {
  assert.equal(formatDuration(5 * DAY + 14 * HOUR + 59 * 60_000), '5d 14h');
  assert.equal(formatDuration(2 * DAY), '2d');
  assert.equal(formatDuration(3 * HOUR + 20 * 60_000), '3h 20m');
  assert.equal(formatDuration(12 * 60_000), '12m');
  assert.equal(formatDuration(30_000), 'under a minute');
});

test('expiryUsage is the elapsed share of the mandate, then expired', () => {
  const since = NOW - DAY;
  const end = Math.floor((NOW + 3 * DAY) / 1000);
  assert.deepEqual(expiryUsage(since, end, NOW), { used: 0.25, value: 'in 3d', over: false });
  assert.deepEqual(expiryUsage(since, end, NOW + 3 * DAY), {
    used: 1,
    value: 'expired',
    over: true,
  });
  // A mandate that starts after `now` (a clock skew) draws empty, not negative.
  assert.equal(expiryUsage(NOW + HOUR, end, NOW).used, 0);
});

test('isTrading means an event in the last 24 hours', () => {
  assert.equal(isTrading(undefined, NOW), false);
  assert.equal(isTrading(summary(), NOW), false);
  assert.equal(isTrading(summary({ lastEvent: event('thesis', {}) }), NOW), true);
  const old = event('thesis', {}, { at: NOW - DAY - 1 });
  assert.equal(isTrading(summary({ lastEvent: old }), NOW), false);
});

test('relativeAge counts in the largest whole unit', () => {
  assert.equal(relativeAge(NOW - 10_000, NOW), 'now');
  assert.equal(relativeAge(NOW - 4 * 60_000, NOW), '4m');
  assert.equal(relativeAge(NOW - 3 * HOUR, NOW), '3h');
  assert.equal(relativeAge(NOW - 2 * DAY, NOW), '2d');
});

test('venuesCaption names each venue and Perpl’s leverage', () => {
  assert.equal(venuesCaption(mandate), 'Kuru spot');
  assert.equal(venuesCaption({ ...mandate, venues: ['perpl'] }), 'Perpl perps · 2×');
  assert.equal(
    venuesCaption({ ...mandate, venues: ['kuru', 'perpl'] }),
    'Kuru spot · Perpl perps · 2×',
  );
});

test('mainHolding prefers the larger stablecoin and never headlines MON', () => {
  const usdc = { symbol: 'USDC', atoms: 412_000_000n, decimals: 6 };
  const ausd = { symbol: 'AUSD', atoms: 612_400_000n, decimals: 6 };
  const mon = { symbol: 'MON', atoms: 10n ** 20n, decimals: 18 };
  assert.equal(mainHolding([usdc, ausd, mon], 'USDC'), ausd);
  assert.equal(mainHolding([{ ...usdc, atoms: 0n }, mon], 'USDC')?.symbol, 'USDC');
  assert.equal(holdsReturnable([{ ...usdc, atoms: 0n }, mon]), false);
  assert.equal(holdsReturnable([usdc, mon]), true);
  assert.equal(formatHolding(usdc), '412.00');
});

test('describeMove turns each Ledger kind into a stone and a line', () => {
  assert.deepEqual(describeMove(event('thesis', { market: 'MON-PERP' })), {
    stone: 'thesis',
    line: 'Wrote a thesis on MON-PERP',
    at: NOW - 4 * 60_000,
  });
  assert.equal(
    describeMove(
      event('fill', { venue: 'kuru', symbol: 'MON-USDC', side: 'buy', filledSize: '260' }),
    )?.line,
    'Bought 260 MON-USDC on Kuru',
  );
  assert.equal(
    describeMove(event('refusal', { code: 'policy_violation' }, { layer: 'enclave' }))?.stone,
    'refusal',
  );
  assert.deepEqual(describeMove(event('close', { symbol: 'BTC-PERP', realizedPnl: '-4.1' })), {
    stone: 'loss',
    line: 'Closed BTC-PERP at −4.1',
    at: NOW - 4 * 60_000,
  });
  assert.equal(
    describeMove(
      event('deposit', { asset: 'USDC', amount: '250', rawAmount: '250000000', decimals: 6 }),
    )?.line,
    'Received 250.00 USDC',
  );
  // A run summary is not a move.
  assert.equal(describeMove(event('run', {})), null);
});
