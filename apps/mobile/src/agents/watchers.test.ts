/**
 * The Watchers section's words (SEN-182). Plain node, no device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { AgentMandate, WatcherDto } from './api.ts';
import { KURU_MARKETS } from './mandate.ts';
import {
  bodyOf,
  clauseParts,
  describeWatcher,
  emptyForm,
  firedLine,
  formOf,
  marketChoices,
  newWatcherId,
  triggerLine,
  watchersSummary,
  type MarketChoice,
} from './watchers.ts';

const NOW = Date.parse('2026-10-09T12:00:00.000Z');
const MON_USDC = KURU_MARKETS.find((m) => m.symbol === 'MON-USDC')!;

function watcher(patch: Partial<WatcherDto>): WatcherDto {
  return {
    id: 'w1',
    label: 'test',
    match: 'all',
    clauses: [],
    reads: '',
    cooldownMinutes: 60,
    setBy: 'agent',
    lastEvaluatedAt: null,
    lastFiredAt: null,
    fireCount: 0,
    lastObserved: null,
    lastError: null,
    ...patch,
  };
}

const MACD_CROSS = watcher({
  clauses: [
    {
      type: 'indicator',
      venue: 'perpl',
      market: 'BTC-PERP',
      timeframe: '15m',
      indicator: { type: 'macd', fast: 12, slow: 26, signal: 9 },
      output: 'line',
      op: 'crosses_above',
      compareTo: { indicator: { type: 'macd', fast: 12, slow: 26, signal: 9 }, output: 'signal' },
    },
  ],
});

test('renders every kind of condition as a sentence an owner reads', () => {
  const cases: [WatcherDto['clauses'][number], string][] = [
    [
      {
        type: 'price',
        venue: 'perpl',
        market: 'BTC-PERP',
        source: 'mark',
        op: 'crosses_above',
        value: 100000,
      },
      'BTC-PERP price crosses above 100,000',
    ],
    [
      {
        type: 'price',
        venue: 'kuru',
        market: 'MON-USDC',
        source: 'last',
        op: 'below',
        value: 3.25,
      },
      'MON-USDC last trade is below 3.25',
    ],
    [
      { type: 'price_band', venue: 'kuru', market: 'MON-USDC', op: 'leaves', low: 3, high: 4 },
      'MON-USDC price leaves 3 – 4',
    ],
    [
      {
        type: 'indicator',
        venue: 'kuru',
        market: 'MON-USDC',
        timeframe: '5m',
        indicator: { type: 'rsi', period: 14 },
        output: 'value',
        op: 'below',
        value: 30,
      },
      'MON-USDC 5m: RSI 14 is below 30',
    ],
    [
      {
        type: 'indicator',
        venue: 'perpl',
        market: 'BTC-PERP',
        timeframe: '1h',
        indicator: { type: 'ema', period: 20 },
        op: 'crosses_below',
        compareTo: { indicator: { type: 'ema', period: 50 } },
      },
      'BTC-PERP 1h: EMA 20 crosses below EMA 50',
    ],
    [
      { type: 'position', market: 'BTC-PERP', op: 'pnl_below', value: -5 },
      'Its BTC-PERP P&L is below -5% of margin',
    ],
    [{ type: 'position', market: 'BTC-PERP', op: 'opened' }, 'Its BTC-PERP position opens'],
    [
      { type: 'funding', market: 'BTC-PERP', op: 'above', value: 0.01 },
      'BTC-PERP funding is above 0.01% per 8h',
    ],
  ];
  for (const [clause, expected] of cases) {
    assert.equal(
      clauseParts(clause)
        .map((p) => p.text)
        .join(''),
      expected,
    );
  }
  assert.equal(
    describeWatcher(MACD_CROSS),
    'BTC-PERP 15m: MACD line crosses above its signal line',
  );
});

test('marks the numbers and names as values, and joins clauses by all or any', () => {
  const parts = clauseParts(MACD_CROSS.clauses[0]!);
  assert.deepEqual(
    parts.filter((p) => p.value).map((p) => p.text),
    ['BTC-PERP', '15m', 'MACD line'],
  );
  const two = watcher({
    match: 'any',
    clauses: [
      { type: 'price', venue: 'perpl', market: 'BTC-PERP', op: 'below', value: 90000 },
      { type: 'position', market: 'BTC-PERP', op: 'closed' },
    ],
  });
  assert.equal(
    describeWatcher(two),
    'BTC-PERP price is below 90,000 or its BTC-PERP position closes',
  );
});

test('says how it fires and when it last did', () => {
  assert.equal(triggerLine(MACD_CROSS), 'Fires the moment it happens, then rests 1h');
  assert.equal(
    triggerLine(
      watcher({
        cooldownMinutes: 15,
        clauses: [{ type: 'price', venue: 'kuru', market: 'MON-USDC', op: 'below', value: 3 }],
      }),
    ),
    'Fires while true, at most once every 15m',
  );
  assert.equal(firedLine(watcher({}), NOW), 'Never fired');
  assert.equal(
    firedLine(
      watcher({ fireCount: 1, lastFiredAt: new Date(NOW - 12 * 60_000).toISOString() }),
      NOW,
    ),
    'Fired once, 12m ago',
  );
  assert.equal(
    firedLine(
      watcher({ fireCount: 4, lastFiredAt: new Date(NOW - 2 * 3_600_000).toISOString() }),
      NOW,
    ),
    'Fired 4 times, last 2h ago',
  );
});

test('the summary line counts the wakes and the model calls saved', () => {
  const one = [MACD_CROSS];
  assert.equal(
    watchersSummary({ everySeconds: 300, wakes: 3, modelCallsSaved: 214, watchers: one }),
    'Checked every 5m without the model · woke it 3 times · saved ~214 model calls',
  );
  assert.equal(
    watchersSummary({ everySeconds: 300, wakes: 1, modelCallsSaved: 1, watchers: one }),
    'Checked every 5m without the model · woke it once · saved ~1 model call',
  );
  assert.equal(
    watchersSummary({ everySeconds: 900, wakes: 0, modelCallsSaved: 0, watchers: [] }),
    'None set, so the model runs every 15m. The agent can set watchers, or you can add one.',
  );
  assert.equal(
    watchersSummary({ everySeconds: null, wakes: 0, modelCallsSaved: 0, watchers: one }),
    'Not checked: it runs only when you run it. Pick a cadence to have these checked.',
  );
});

const MARKETS: MarketChoice[] = [
  { symbol: 'MON-USDC', venue: 'kuru' },
  { symbol: 'BTC-PERP', venue: 'perpl' },
];

test('the edit form round-trips the common cases and refuses the rest', () => {
  const macd = formOf(MACD_CROSS)!;
  assert.deepEqual(macd, {
    kind: 'macd',
    label: 'test',
    market: 'BTC-PERP',
    op: 'crosses_above',
    value: '',
    timeframe: '15m',
    cooldownMinutes: 60,
  });
  assert.deepEqual(bodyOf(macd, MARKETS), {
    body: {
      label: 'test',
      match: 'all',
      cooldownMinutes: 60,
      clauses: [
        {
          type: 'indicator',
          venue: 'perpl',
          market: 'BTC-PERP',
          timeframe: '15m',
          indicator: { type: 'macd' },
          output: 'line',
          op: 'crosses_above',
          compareTo: { output: 'signal' },
        },
      ],
    },
  });

  const rsi = {
    ...emptyForm(MARKETS),
    kind: 'rsi' as const,
    label: 'oversold',
    op: 'below' as const,
    value: '30',
    timeframe: '5m',
  };
  const built = bodyOf(rsi, MARKETS);
  assert.ok('body' in built);
  assert.deepEqual(
    formOf(
      watcher({
        ...built.body,
        match: 'all',
        clauses: built.body.clauses.map((c) => ({ ...c, output: 'value' })),
      }),
    ),
    {
      ...rsi,
    },
  );

  // Several clauses, or a kind the sheet has no form for: describe only.
  assert.equal(formOf(watcher({ clauses: [...MACD_CROSS.clauses, ...MACD_CROSS.clauses] })), null);
  assert.equal(
    formOf(
      watcher({ clauses: [{ type: 'funding', market: 'BTC-PERP', op: 'above', value: 0.01 }] }),
    ),
    null,
  );
});

test('the edit form says what is wrong before anything is sent', () => {
  const form = { ...emptyForm(MARKETS), label: 'breakout', value: '100000' };
  assert.deepEqual(bodyOf({ ...form, label: '  ' }, MARKETS), {
    error: 'Say what this watcher is for, in a few words.',
  });
  assert.deepEqual(bodyOf({ ...form, market: 'ETH-PERP' }, MARKETS), {
    error: 'Pick one of the markets in its mandate.',
  });
  assert.deepEqual(bodyOf({ ...form, value: '1e5' }, MARKETS), { error: 'Enter a number.' });
  assert.deepEqual(bodyOf({ ...form, value: '0' }, MARKETS), { error: 'A price is above zero.' });
  assert.deepEqual(bodyOf({ ...form, kind: 'rsi', value: '130' }, MARKETS), {
    error: 'RSI runs from 0 to 100.',
  });
  assert.deepEqual(bodyOf({ ...form, kind: 'pnl', market: 'MON-USDC', value: '5' }, MARKETS), {
    error: 'P&L watchers are for Perpl positions.',
  });
  const pnl = bodyOf(
    { ...form, kind: 'pnl', market: 'BTC-PERP', op: 'below', value: '-5' },
    MARKETS,
  );
  assert.ok('body' in pnl);
  assert.deepEqual(pnl.body.clauses, [
    { type: 'position', market: 'BTC-PERP', op: 'pnl_below', value: -5 },
  ]);
});

test('offers the mandate’s markets by symbol, and fresh ids', () => {
  const mandate = {
    venues: ['kuru', 'perpl'],
    kuru: { markets: [MON_USDC.address], maxDepositAtoms: {} },
    perpl: { maxCollateralAtoms: 0n, maxLeverage: 5, markets: ['BTC-PERP'] },
  } as unknown as AgentMandate;
  assert.deepEqual(marketChoices(mandate), MARKETS);
  assert.deepEqual(marketChoices({ ...mandate, venues: ['kuru'] }), [MARKETS[0]]);
  const id = newWatcherId([], NOW);
  assert.match(id, /^you-[0-9a-z]{1,6}$/);
  assert.notEqual(newWatcherId([{ id }], NOW), id);
});
