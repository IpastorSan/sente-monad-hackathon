/**
 * What preset cards say (SEN-114): risk from the suggested mandate, the
 * cadence label, where it trades, the filter chips, and the stats line —
 * always with its sample, and "Too new to rate" under `minN`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PresetStatsDto } from './api.ts';
import {
  cadenceLabel,
  defaultMarkets,
  matchesFilter,
  riskOf,
  statsLine,
  venueLine,
  type PresetFilter,
} from './cards.ts';
import { bundledCatalog } from './catalog.ts';

const catalog = new Map(bundledCatalog().map((preset) => [preset.id, preset]));
function preset(id: string) {
  const found = catalog.get(id);
  assert.ok(found, id);
  return found;
}

test('risk follows the study: tier cautious/standard/wide is Low/Med/High', () => {
  const expected: Record<string, string> = {
    guardian: 'Low',
    'range-trader': 'Med',
    'trend-rider': 'High',
    'funding-harvester': 'Low',
    'dca-stacker': 'Low',
    'mean-reverter': 'Med',
  };
  for (const [id, label] of Object.entries(expected)) {
    const risk = riskOf(preset(id));
    assert.equal(risk.label, label, id);
    assert.equal(risk.stones, { Low: 1, Med: 2, High: 3 }[label]);
  }
});

test('cadence labels', () => {
  assert.equal(cadenceLabel(60), 'Every minute');
  assert.equal(cadenceLabel(300), '5 min');
  assert.equal(cadenceLabel(900), '15 min');
  assert.equal(cadenceLabel(3_600), '1 hour');
  assert.equal(cadenceLabel(14_400), '4 hours');
  assert.equal(cadenceLabel(86_400), 'Daily');
  assert.equal(cadenceLabel(604_800), 'Weekly');
  assert.equal(cadenceLabel(90), '90 s');
});

test('venue line names the venue the market parameter trades on', () => {
  assert.equal(venueLine(preset('range-trader')), 'Kuru spot');
  assert.equal(venueLine(preset('trend-rider')), 'Perpl perps');
  assert.equal(venueLine(preset('funding-harvester')), 'Perpl + Kuru');
  assert.equal(venueLine(preset('mean-reverter')), 'Kuru or Perpl');
});

test('the token stack shows the default market only', () => {
  assert.deepEqual(defaultMarkets(preset('guardian')), ['MON-USDC']);
  assert.deepEqual(defaultMarkets(preset('trend-rider')), ['BTC-PERP']);
});

test('filters: spot and perps follow the traded market; low is one stone', () => {
  const ids = (filter: PresetFilter) =>
    bundledCatalog()
      .filter((p) => matchesFilter(p, filter))
      .map((p) => p.id);
  assert.equal(ids('all').length, 6);
  assert.deepEqual(ids('spot'), ['guardian', 'range-trader', 'dca-stacker', 'mean-reverter']);
  assert.deepEqual(ids('perps'), ['trend-rider', 'funding-harvester', 'mean-reverter']);
  assert.deepEqual(ids('low'), ['guardian', 'funding-harvester', 'dca-stacker']);
});

function stats(over: Partial<PresetStatsDto>): PresetStatsDto {
  return {
    presetId: 'range-trader',
    window: '30d',
    running: 23,
    n: 23,
    minN: 5,
    medianPnl30d: '4.1',
    medianReturn30d: '0.028',
    returnN: 20,
    customized: 2,
    definition: '',
    notes: [],
    asOf: 0,
    ...over,
  };
}

test('no stats, no line: never zeros', () => {
  assert.equal(statsLine(undefined), null);
  assert.equal(statsLine(null), null);
});

test('the median return is printed over its own sample, returnN', () => {
  assert.deepEqual(statsLine(stats({})), {
    running: '23 running',
    figure: { kind: 'median', value: '+2.8%', direction: 'up' },
    sample: '30d · n=20',
  });
  const down = statsLine(stats({ medianReturn30d: '-0.012', returnN: 11 }));
  assert.deepEqual(down?.figure, { kind: 'median', value: '−1.2%', direction: 'down' });
  assert.equal(down?.sample, '30d · n=11');
});

test('below minN it is too new to rate, with the cohort sample still shown', () => {
  assert.deepEqual(
    statsLine(stats({ running: 3, n: 4, medianPnl30d: null, medianReturn30d: null })),
    { running: '3 running', figure: { kind: 'too-new' }, sample: '30d · n=4' },
  );
});

test('without a return the median P&L stands in, as ≈ $ over n', () => {
  const line = statsLine(stats({ medianReturn30d: null, returnN: 0, medianPnl30d: '-3.2' }));
  assert.deepEqual(line?.figure, { kind: 'median', value: '≈ −$3.20', direction: 'down' });
  assert.equal(line?.sample, '30d · n=23');
  const flat = statsLine(stats({ medianReturn30d: null, medianPnl30d: '0.001' }));
  assert.deepEqual(flat?.figure, { kind: 'median', value: '≈ $0.00', direction: 'flat' });
});

test('neither median: the running count and the sample, no figure', () => {
  assert.deepEqual(statsLine(stats({ medianReturn30d: null, medianPnl30d: null }))?.figure, {
    kind: 'none',
  });
});
