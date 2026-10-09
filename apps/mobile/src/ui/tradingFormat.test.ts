/** Trading kit formatters (SEN-108). Plain node, no device. */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  asOfLabel,
  formatPct,
  formatPrice,
  glyphFor,
  isStale,
  leverageTag,
  maskDigits,
  pctChange,
  pctDirection,
  pressureSplit,
  splitDecimals,
} from './tradingFormat.ts';

test('splitDecimals pads, groups and splits at the point', () => {
  assert.deepEqual(splitDecimals('1284.5', 2), { whole: '1,284', fraction: '.50' });
  assert.deepEqual(splitDecimals('0.98125', 4), { whole: '0', fraction: '.9813' });
  assert.deepEqual(splitDecimals('3918', 0), { whole: '3,918', fraction: '' });
  assert.deepEqual(splitDecimals('-12.3', 2), { whole: '−12', fraction: '.30' });
  assert.equal(splitDecimals('1,284', 2), null);
});

test('formatPrice rounds to the tick grid and shows its decimals', () => {
  assert.equal(formatPrice('64188.46', '0.5'), '64,188.5');
  assert.equal(formatPrice('64188.24', '0.5'), '64,188.0');
  assert.equal(formatPrice('64188.25', '0.5'), '64,188.5');
  assert.equal(formatPrice('0.98125', '0.0001'), '0.9813');
  assert.equal(formatPrice('2544.1', '0.01'), '2,544.10');
  assert.equal(formatPrice('2544.6', '1'), '2,545');
  assert.equal(formatPrice('1234', '5'), '1,235');
  assert.equal(formatPrice('0.10000', '0.010'), '0.10');
});

test('formatPrice without a tick follows the chart rule', () => {
  assert.equal(formatPrice('0.98125'), '0.9813');
  assert.equal(formatPrice('2544.1'), '2,544.10');
});

test('formatPrice signs and refusals', () => {
  assert.equal(formatPrice('-1.26', '0.1'), '−1.3');
  assert.equal(formatPrice('-0.001', '0.01'), '0.00');
  assert.equal(formatPrice('abc', '0.01'), null);
  assert.equal(formatPrice('1', '0'), null);
  assert.equal(formatPrice('1', '-0.1'), null);
});

test('pctChange measures from the base, null without one', () => {
  assert.equal(pctChange('100', '102.41')?.toFixed(2), '2.41');
  assert.equal(pctChange('100', '98.88')?.toFixed(2), '-1.12');
  assert.equal(pctChange('0', '1'), null);
  assert.equal(pctChange('x', '1'), null);
});

test('formatPct rounds the decimal it was given, not its binary neighbour (SEN-136)', () => {
  // Pre-fix `toFixed` read 2.675 and 1.005 as 2.67499… and 1.00499….
  assert.equal(formatPct(2.675), '+2.68%');
  assert.equal(formatPct(-1.005), '−1.01%');
  assert.equal(pctDirection(1.005), 'up');
  // Pre-fix: `+1e+21%`.
  assert.equal(formatPct(1e21), '+1,000,000,000,000,000,000,000.00%');
});

test('formatPct and pctDirection agree on the rounded figure', () => {
  assert.equal(formatPct(2.4149), '+2.41%');
  assert.equal(formatPct(-1.12), '−1.12%');
  assert.equal(formatPct(0.001), '0.00%');
  assert.equal(pctDirection(0.001), 'flat');
  assert.equal(pctDirection(0.006), 'up');
  assert.equal(pctDirection(-3), 'down');
  assert.equal(formatPct(null), '—');
  assert.equal(pctDirection(null), 'flat');
  assert.equal(formatPct(12.345, 1), '+12.3%');
});

test('asOfLabel steps through units and clamps the future', () => {
  const now = 1_000_000_000;
  assert.equal(asOfLabel(now - 3_400, now), 'as of 3s');
  assert.equal(asOfLabel(now + 5_000, now), 'as of 0s');
  assert.equal(asOfLabel(now - 59_999, now), 'as of 59s');
  assert.equal(asOfLabel(now - 60_000, now), 'as of 1m');
  assert.equal(asOfLabel(now - 2 * 3_600_000, now), 'as of 2h');
  assert.equal(asOfLabel(now - 4 * 86_400_000, now), 'as of 4d');
});

test('isStale after the threshold', () => {
  assert.equal(isStale(0, 30_000), false);
  assert.equal(isStale(0, 30_001), true);
  assert.equal(isStale(0, 5_001, 5_000), true);
});

test('leverageTag', () => {
  assert.equal(leverageTag(20), 'PERP 20×');
  assert.equal(leverageTag(2.5), 'PERP 2.5×');
  assert.equal(leverageTag(undefined), 'PERP');
  assert.equal(leverageTag(null), 'PERP');
  assert.equal(leverageTag(0), 'PERP');
  assert.equal(leverageTag(Number.NaN), 'PERP');
});

test('glyphFor finds the base asset under wrappers', () => {
  assert.deepEqual(glyphFor('MON'), { letter: 'M', tint: '#DDD7FE' });
  assert.equal(glyphFor('cbBTC').letter, 'B');
  assert.equal(glyphFor('cbBTC').tint, glyphFor('BTC').tint);
  assert.equal(glyphFor('WETH').letter, 'E');
  assert.equal(glyphFor('ETH-PERP').tint, glyphFor('ETH').tint);
  assert.equal(glyphFor('XAUt').letter, 'X');
  // Kuru's current symbols (SEN-185): WBTC is BTC's stone, XAUT is gold's.
  assert.equal(glyphFor('WBTC').tint, glyphFor('BTC').tint);
  assert.equal(glyphFor('XAUT').tint, glyphFor('XAU').tint);
  assert.equal(glyphFor('ZZZ').tint, '#DDD7FE');
});

test('pressureSplit adds to 100 and refuses an empty book', () => {
  assert.deepEqual(pressureSplit('62', '38'), { bid: 62, ask: 38 });
  assert.deepEqual(pressureSplit('1', '2'), { bid: 33, ask: 67 });
  assert.deepEqual(pressureSplit('5', '0'), { bid: 100, ask: 0 });
  assert.equal(pressureSplit('0', '0'), null);
});

test('maskDigits keeps separators', () => {
  assert.equal(maskDigits('3,918'), '•,•••');
  assert.equal(maskDigits('.40'), '.••');
});
