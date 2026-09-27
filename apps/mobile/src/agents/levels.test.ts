/**
 * Where each preset's stop and target sit, and whether each is an order or
 * only watched (SEN-117). Plain node, no device.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { renderPreset } from '@sente/presets';

import {
  LIQUIDATION_GUARD_PCT,
  levelLabel,
  levelsNote,
  presetLevels,
  stopAndTarget,
  type AgentLevel,
} from './levels.ts';

const brief = (levels: AgentLevel[]) =>
  levels.map((level) => `${level.role} ${level.price} ${level.source}`);

test('Range Trader: the target is a resting order, the stop is watched', () => {
  const levels = presetLevels(
    { id: 'range-trader', params: { target: 3, stop: 3 } },
    { entry: '0.9744', side: 'long' },
  );
  assert.deepEqual(brief(levels), ['target 1.0036 order', 'stop 0.9452 watched']);
  assert.equal(levelLabel(levels[0]!), 'TARGET · ORDER');
  assert.equal(levelLabel(levels[1]!), 'STOP · WATCHED');
});

test('an absent param falls back to the catalog default, a bad one drops every level', () => {
  // range-trader defaults: target 3, stop 3.
  assert.deepEqual(
    brief(presetLevels({ id: 'range-trader', params: {} }, { entry: '1', side: 'long' })),
    ['target 1.0300 order', 'stop 0.9700 watched'],
  );
  assert.deepEqual(
    presetLevels({ id: 'range-trader', params: { target: 'x' } }, { entry: '1', side: 'long' }),
    [],
  );
});

test('Mean Reverter: target is the take-back share of the stretch, on either side', () => {
  const preset = { id: 'mean-reverter', params: { stretch: 4, takeBack: 50, stop: 3 } };
  assert.deepEqual(brief(presetLevels(preset, { entry: '100.00', side: 'long' })), [
    'target 102.0000 order',
    'stop 97.0000 watched',
  ]);
  assert.deepEqual(brief(presetLevels(preset, { entry: '100.00', side: 'short' })), [
    'target 98.0000 order',
    'stop 103.0000 watched',
  ]);
});

test('Guardian: both lines as the owner drew them, both watched', () => {
  const levels = presetLevels(
    { id: 'guardian', params: { sellAbove: 0.05, sellBelow: 0.01 } },
    { entry: '0.03', side: 'long' },
  );
  assert.deepEqual(brief(levels), ['target 0.05 watched', 'stop 0.01 watched']);
  assert.equal(levelLabel(levels[0]!), 'SELL ABOVE · WATCHED');
});

test('Trend Rider: a watched trailing stop from the best price since entry', () => {
  const preset = { id: 'trend-rider', params: { trailingStop: 4 } };
  assert.deepEqual(brief(presetLevels(preset, { entry: '100', side: 'long' })), [
    'stop 96.0000 watched',
  ]);
  assert.deepEqual(brief(presetLevels(preset, { entry: '100', side: 'long', extreme: '110' })), [
    'stop 105.6000 watched',
  ]);
  // A short trails from the lowest price, and a stale high never loosens it.
  assert.deepEqual(brief(presetLevels(preset, { entry: '100', side: 'short', extreme: '90' })), [
    'stop 93.6000 watched',
  ]);
  assert.deepEqual(brief(presetLevels(preset, { entry: '100', side: 'long', extreme: '95' })), [
    'stop 96.0000 watched',
  ]);
});

test('Funding Harvester: a watched liquidation guard on the mark side of liq, none without liq', () => {
  const preset = { id: 'funding-harvester', params: {} };
  assert.deepEqual(brief(presetLevels(preset, { entry: '0.9920', side: 'short', liq: '1.4800' })), [
    'stop 1.3320 watched',
  ]);
  assert.deepEqual(presetLevels(preset, { entry: '0.9920', side: 'short', liq: null }), []);
});

test('the guard percent is the one the preset tells the agent', () => {
  const rendered = renderPreset('funding-harvester', {});
  assert.ok(rendered.ok);
  assert.match(
    rendered.strategy,
    new RegExp(`within ${LIQUIDATION_GUARD_PCT}% of its liquidation`),
  );
});

test('no levels without a preset, for DCA, for an unknown preset, or once edited', () => {
  const input = { entry: '1', side: 'long' } as const;
  assert.deepEqual(presetLevels(null, input), []);
  assert.deepEqual(presetLevels({ id: 'dca-stacker', params: {} }, input), []);
  assert.deepEqual(presetLevels({ id: 'moon-shot', params: {} }, input), []);
  assert.deepEqual(presetLevels({ id: 'range-trader', params: {}, customized: true }, input), []);
  assert.deepEqual(presetLevels({ id: 'range-trader', params: {} }, { ...input, entry: '0' }), []);
});

test('stopAndTarget pairs them only when both exist', () => {
  const range = presetLevels({ id: 'range-trader', params: {} }, { entry: '1', side: 'long' });
  assert.deepEqual(stopAndTarget(range), { target: '1.0300', stop: '0.9700' });
  const trail = presetLevels({ id: 'trend-rider', params: {} }, { entry: '1', side: 'long' });
  assert.equal(stopAndTarget(trail), null);
});

test('levelsNote says which levels rest on the venue and which are only checked', () => {
  const range = presetLevels({ id: 'range-trader', params: {} }, { entry: '1', side: 'long' });
  assert.equal(
    levelsNote(range, 'kuru'),
    'Target rests on Kuru as a limit order; stop is checked each run, not an order.',
  );
  const guardian = presetLevels(
    { id: 'guardian', params: { sellAbove: 2, sellBelow: 0.5 } },
    { entry: '1', side: 'long' },
  );
  assert.equal(
    levelsNote(guardian, 'kuru'),
    'Sell above and sell below are levels the agent checks each run, not orders on Kuru.',
  );
  const trail = presetLevels({ id: 'trend-rider', params: {} }, { entry: '1', side: 'long' });
  assert.equal(
    levelsNote(trail, 'perpl'),
    'Trailing stop is a level the agent checks each run, not an order on Perpl.',
  );
  assert.equal(levelsNote([], 'kuru'), null);
});
